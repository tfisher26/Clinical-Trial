import fs from 'node:fs';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

/**
 * Loads the NLM MeSH descriptor vocabulary into mesh_descriptor /
 * mesh_term so condition classification can run as a local SQL join
 * instead of one API call per condition string.
 *
 * Run this ONCE, then again only when NLM publishes a new edition
 * (annually). It is not part of the daily pipeline.
 *
 *   node jobs/load-mesh.js                      # download + load
 *   node jobs/load-mesh.js --file x.xml --dry   # parse a local file, print stats
 *
 * The uncompressed file is ~313MB, so it is streamed and parsed a
 * record at a time — never held in memory whole.
 */

const YEAR = process.env.MESH_YEAR || '2026';
const BASE = 'https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh';

// Keep only descriptors carrying at least one Disease (C) or Mental
// Disorder (F) tree number. Drops chemicals, anatomy, techniques and so
// on — roughly three quarters of the file — which keeps the term table
// small and, more importantly, stops drug names fuzzy-matching against
// condition strings. Broader than mesh_branch_category on purpose, so
// adding a branch there later doesn't force a reload.
const KEEP_TREE_PREFIXES = ['C', 'F'];

const DB_CHUNK = 500;

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // last, so &amp;lt; doesn't become <
}

function clean(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/**
 * Pulls the fields we need out of one <DescriptorRecord> block.
 *
 * Deliberately positional in two places: DescriptorUI and
 * DescriptorName both appear AGAIN inside PharmacologicalActionList,
 * referring to other descriptors. The record's own always comes first,
 * so the first match is the right one.
 */
export function parseRecord(xml) {
  const uiMatch = xml.match(/<DescriptorUI>([^<]+)<\/DescriptorUI>/);
  if (!uiMatch) return null;

  const nameMatch = xml.match(/<DescriptorName>\s*<String>([\s\S]*?)<\/String>/);
  if (!nameMatch) return null;

  const treeNumbers = [...xml.matchAll(/<TreeNumber>([^<]+)<\/TreeNumber>/g)].map((m) => m[1].trim());
  if (!treeNumbers.length) return null;
  if (!treeNumbers.some((t) => KEEP_TREE_PREFIXES.includes(t[0]))) return null;

  // A Term's own <String> is the one right after its <TermUI>. Anchoring
  // on TermUI avoids picking up <ConceptName><String> or <ScopeNote>.
  const terms = [];
  const termRe = /<Term\s+([^>]*?)>\s*<TermUI>[^<]*<\/TermUI>\s*<String>([\s\S]*?)<\/String>/g;
  for (const m of xml.matchAll(termRe)) {
    const attrs = m[1];
    const text = clean(m[2]);
    if (!text) continue;
    // IsPermutedTermYN covers BOTH useful variants ("Abdominal Neoplasm",
    // the singular) and mechanical inversions ("Neoplasms, Abdominal").
    // That is 46% of all terms, so dropping them costs real recall —
    // CT.gov uses singular forms constantly. Keep them, flag them, and
    // let the SQL classifier rank and filter.
    terms.push({
      text,
      isPreferred: /RecordPreferredTermYN\s*=\s*"Y"/.test(attrs),
      isPermuted: /IsPermutedTermYN\s*=\s*"Y"/.test(attrs),
    });
  }

  return {
    ui: uiMatch[1].trim(),
    name: clean(nameMatch[1]),
    treeNumbers,
    terms,
  };
}

/** Yields parsed records from a stream, splitting on record boundaries. */
export async function* iterateRecords(stream) {
  let buffer = '';
  const DELIM = '</DescriptorRecord>';

  for await (const chunk of stream) {
    buffer += chunk.toString('utf-8');
    let idx;
    while ((idx = buffer.indexOf(DELIM)) !== -1) {
      const raw = buffer.slice(0, idx + DELIM.length);
      buffer = buffer.slice(idx + DELIM.length);
      const start = raw.indexOf('<DescriptorRecord');
      if (start === -1) continue;
      const rec = parseRecord(raw.slice(start));
      if (rec) yield rec;
    }
    // A truncated sample (or the file's trailing bytes) leaves a partial
    // record in the buffer. Dropping it is correct.
  }
}

async function openStream({ file }) {
  if (file) {
    const s = fs.createReadStream(file);
    return file.endsWith('.gz') ? s.pipe(createGunzip()) : s;
  }
  const url = `${BASE}/desc${YEAR}.gz`;
  console.log(`load-mesh: downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  return Readable.fromWeb(res.body).pipe(createGunzip());
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
  const dry = args.includes('--dry');

  const stream = await openStream({ file });

  let kept = 0;
  let termCount = 0;
  let descBatch = [];
  let termBatch = [];
  const sampleOut = [];

  let db = null;
  if (!dry) ({ db } = await import('./lib/db.js'));

  async function flush(force = false) {
    if (dry) { descBatch = []; termBatch = []; return; }
    if (descBatch.length >= DB_CHUNK || (force && descBatch.length)) {
      const { error } = await db.from('mesh_descriptor').upsert(descBatch, { onConflict: 'ui' });
      if (error) throw new Error(`mesh_descriptor upsert failed: ${error.message}`);
      descBatch = [];
    }
    if (termBatch.length >= DB_CHUNK * 4 || (force && termBatch.length)) {
      const { error } = await db
        .from('mesh_term')
        .upsert(termBatch, { onConflict: 'term_norm,descriptor_ui', ignoreDuplicates: true });
      if (error) throw new Error(`mesh_term upsert failed: ${error.message}`);
      termBatch = [];
    }
  }

  for await (const rec of iterateRecords(stream)) {
    kept++;
    termCount += rec.terms.length;

    descBatch.push({ ui: rec.ui, name: rec.name, tree_numbers: rec.treeNumbers });

    // Normalization must match mesh_normalize() in migration 006.
    // Sort non-permuted first so that when two terms normalize to the
    // same string, the better-quality flag wins.
    const seen = new Set();
    for (const t of [...rec.terms].sort((a, b) => Number(a.isPermuted) - Number(b.isPermuted))) {
      const norm = t.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      termBatch.push({
        term_norm: norm,
        descriptor_ui: rec.ui,
        is_preferred: t.isPreferred,
        is_permuted: t.isPermuted,
      });
    }

    if (sampleOut.length < 3) sampleOut.push(rec);
    if (kept % 2000 === 0) console.log(`  ${kept} descriptors, ${termCount} terms...`);
    await flush();
  }
  await flush(true);

  console.log(`load-mesh complete: ${kept} descriptors, ${termCount} terms${dry ? ' (dry run, nothing written)' : ''}.`);
  if (dry) {
    for (const r of sampleOut) {
      console.log(`\n  ${r.ui}  ${r.name}`);
      console.log(`    trees: ${r.treeNumbers.join(', ')}`);
      console.log(`    terms: ${r.terms.map((t) => t.text + (t.isPreferred ? ' *' : '') + (t.isPermuted ? ' ~' : '')).join(' | ')}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('load-mesh failed:', err);
    process.exit(1);
  });
}
