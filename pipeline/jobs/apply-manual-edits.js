import fs from 'node:fs';
import nodePath from 'node:path';
import { db } from './lib/db.js';
import { readQueue, writeQueue, parseEntries, removeEntries } from './lib/pendingQueue.js';

/**
 * apply-manual-edits — runs when you push changes to any of the
 * pending-NAME/queue.md files (or on demand from the Actions tab). Reads
 * whichever entries you've filled in completely, writes them to the
 * database, then rewrites each file with only the still-unresolved
 * entries left — so the files shrink as you work through them, and
 * nothing you haven't gotten to yet is touched or re-ordered.
 *
 * Writes are batched (hundreds of entries per database call) and every
 * write is checked. This job used to save one entry at a time without
 * checking for errors: a 3,000-headline commit needed ~9,000 sequential
 * calls, ran past the 10-minute limit, and the headlines were being
 * rejected by the database the whole time without anyone knowing.
 *
 * If any write fails, the job stops with an error before the queue files
 * are committed, so nothing is removed from a file unless it was saved.
 * Re-running is safe: every write is an idempotent upsert/update.
 */

const WRITE_CHUNK = 500; // rows per upsert (POST body)
const ID_CHUNK = 200;    // ids per .in() filter (these go in the URL)

async function main() {
  await applySummaries();
  await applyHeadlines();
  await applyQualifyNotes();
  await applyCallouts();
  await applyBasicsExtra();
  await applyCategories();
  await applyRelationships();
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function check(error, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
}

async function upsertAll(table, rows, onConflict, what) {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + WRITE_CHUNK), { onConflict });
    check(error, what);
  }
}

/** nct_id -> selected columns, for the ids that exist in trials_factual. */
async function lookupTrials(ids, columns = 'nct_id') {
  const found = new Map();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await db.from('trials_factual').select(columns).in('nct_id', ids.slice(i, i + ID_CHUNK));
    check(error, 'looking up trials');
    for (const r of data ?? []) found.set(r.nct_id, r);
  }
  return found;
}

/** Completed entries from a queue file, or null if there's nothing to do. */
function completedEntries(path, fields, label) {
  const content = readQueue(path);
  if (!content.trim()) return null;
  const done = parseEntries(content, fields).filter((e) => e.complete);
  if (!done.length) {
    console.log(`apply-manual-edits: no completed ${label} yet.`);
    return null;
  }
  return { content, done };
}

/**
 * Writes one trials_curated column from a queue file. Entries for trials
 * that no longer exist at all are dropped with a warning (there's nowhere
 * to save them); hidden/closed trials still exist and are saved normally.
 */
async function applyCuratedField({ path, field, label, toRow }) {
  const q = completedEntries(path, [field].flat(), label);
  if (!q) return;

  const found = await lookupTrials(q.done.map((e) => e.id));
  const missing = q.done.filter((e) => !found.has(e.id));
  if (missing.length) console.warn(`  ${missing.length} ${label} skipped: trial no longer exists (${missing.slice(0, 5).map((e) => e.id).join(', ')}${missing.length > 5 ? ', …' : ''})`);

  const rows = q.done.filter((e) => found.has(e.id)).map((e) => ({ nct_id: e.id, ...toRow(e.fields) }));
  await upsertAll('trials_curated', rows, 'nct_id', `saving ${label}`);

  writeQueue(path, removeEntries(q.content, q.done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${rows.length} ${label}.`);
}

// ---------------------------------------------------------------------
// Queue files
// ---------------------------------------------------------------------

/**
 * Summaries are spread across pending-summaries/queue-001.md, -002.md and
 * so on, because the backlog is far too large for a single file. Every
 * chunk is read, and each is rewritten separately so a failure part-way
 * through cannot lose the files already processed. The legacy single
 * queue.md is still picked up if it exists.
 */
const SUMMARY_DIR = 'pending-summaries';
const SUMMARY_FILE_RE = /^queue(-\d+)?\.md$/;

async function applySummaries() {
  if (!fs.existsSync(SUMMARY_DIR)) return;
  const files = fs
    .readdirSync(SUMMARY_DIR)
    .filter((f) => SUMMARY_FILE_RE.test(f))
    .sort()
    .map((f) => nodePath.join(SUMMARY_DIR, f));

  let total = 0;

  for (const file of files) {
    const content = readQueue(file);
    if (!content.trim()) continue;

    const done = parseEntries(content, ['SUMMARY']).filter((e) => e.complete);
    if (!done.length) continue;

    const found = await lookupTrials(done.map((e) => e.id), 'nct_id, criteria_hash');
    const gone = done.filter((e) => !found.has(e.id));
    if (gone.length) console.warn(`  ${gone.length} summaries skipped in ${file}: trial no longer exists`);

    const now = new Date().toISOString();
    const rows = done.filter((e) => found.has(e.id)).map((e) => ({
      nct_id: e.id,
      intervention_summary: e.fields.SUMMARY,
      source_criteria_hash: found.get(e.id).criteria_hash,
      model_used: 'manual',
      generated_at: now,
    }));

    await upsertAll('trials_curated', rows, 'nct_id', `saving summaries from ${file}`);

    writeQueue(file, removeEntries(content, done.map((e) => e.id)));
    total += rows.length;
    console.log(`apply-manual-edits: applied ${rows.length} summaries from ${file}.`);
  }

  if (!total) console.log('apply-manual-edits: no completed summaries yet.');
  else console.log(`apply-manual-edits: applied ${total} summaries in total.`);
}

async function applyHeadlines() {
  await applyCuratedField({
    path: 'pending-headlines/queue.md',
    field: 'HEADLINE',
    label: 'headlines',
    toRow: (f) => ({ headline: f.HEADLINE }),
  });
}

async function applyQualifyNotes() {
  await applyCuratedField({
    path: 'pending-qualify-notes/queue.md',
    field: 'QUALIFY_NOTE',
    label: 'qualify notes',
    toRow: (f) => ({ qualify_note: f.QUALIFY_NOTE }),
  });
}

async function applyCallouts() {
  await applyCuratedField({
    path: 'pending-callouts/queue.md',
    field: ['CALLOUT_HEADING', 'CALLOUT_TEXT'],
    label: 'callouts',
    toRow: (f) => ({ extra_callout_heading: f.CALLOUT_HEADING, extra_callout_text: f.CALLOUT_TEXT }),
  });
}

async function applyBasicsExtra() {
  // Opt-in, freeform — you add entries yourself, format:
  // ## NCT12345678
  // LABEL: How often
  // TEXT: Every two weeks for the first month, then monthly.
  const path = 'pending-basics-extra/queue.md';
  const q = completedEntries(path, ['LABEL', 'TEXT'], 'basics_extra entries');
  if (!q) return;

  const ids = [...new Set(q.done.map((e) => e.id))];
  const trials = await lookupTrials(ids);
  const current = new Map();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await db.from('trials_curated').select('nct_id, basics_extra').in('nct_id', ids.slice(i, i + ID_CHUNK));
    check(error, 'reading existing basics_extra');
    for (const r of data ?? []) current.set(r.nct_id, r.basics_extra ?? []);
  }

  // Append, skipping any label/text pair already there so a re-run
  // doesn't add duplicates.
  const updated = new Map();
  for (const e of q.done) {
    if (!trials.has(e.id)) continue;
    const list = updated.get(e.id) ?? [...(current.get(e.id) ?? [])];
    if (!list.some((b) => b.label === e.fields.LABEL && b.text === e.fields.TEXT)) {
      list.push({ label: e.fields.LABEL, text: e.fields.TEXT });
    }
    updated.set(e.id, list);
  }
  const rows = [...updated].map(([nct_id, basics_extra]) => ({ nct_id, basics_extra }));
  await upsertAll('trials_curated', rows, 'nct_id', 'saving basics_extra');

  writeQueue(path, removeEntries(q.content, q.done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${q.done.length} basics_extra entries across ${rows.length} trials.`);
}

async function applyCategories() {
  const path = 'pending-categories/queue.md';
  const q = completedEntries(path, ['CATEGORY', 'CATEGORY_LABEL', 'SUBCATEGORY', 'SUBCATEGORY_LABEL'], 'category classifications');
  if (!q) return;

  const now = new Date().toISOString();
  const rows = q.done.map((e) => ({
    raw_condition: e.id,
    category: e.fields.CATEGORY,
    category_label: e.fields.CATEGORY_LABEL,
    subcategory: e.fields.SUBCATEGORY,
    subcategory_label: e.fields.SUBCATEGORY_LABEL,
    classified_by: 'manual',
    classified_at: now,
  }));
  await upsertAll('condition_taxonomy', rows, 'raw_condition', 'saving categories');

  const ids = rows.map((r) => r.raw_condition);
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { error } = await db.from('condition_taxonomy_pending').delete().in('raw_condition', ids.slice(i, i + ID_CHUNK));
    check(error, 'clearing classified conditions from the pending list');
  }

  writeQueue(path, removeEntries(q.content, ids));
  console.log(`apply-manual-edits: applied ${rows.length} categories.`);
}

async function applyRelationships() {
  const path = 'pending-relationships/queue.md';
  const content = readQueue(path);
  if (!content.trim()) return;

  const done = parseEntries(content, ['RELATIONSHIP']).filter(
    (e) => e.fields.RELATIONSHIP && ['comorbidity', 'independent'].includes(e.fields.RELATIONSHIP.toLowerCase())
  );
  if (!done.length) {
    console.log('apply-manual-edits: no completed relationship checks yet.');
    return;
  }

  const byValue = { comorbidity: [], independent: [] };
  for (const e of done) byValue[e.fields.RELATIONSHIP.toLowerCase()].push(e.id);
  for (const [kind, ids] of Object.entries(byValue)) {
    const value = kind === 'comorbidity' ? 'comorbidity' : null;
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { error } = await db.from('trials_factual').update({ condition_relationship: value }).in('nct_id', ids.slice(i, i + ID_CHUNK));
      check(error, 'saving relationship checks');
    }
  }

  writeQueue(path, removeEntries(content, done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${done.length} relationship check(s).`);
}

main().catch((err) => {
  console.error('apply-manual-edits failed:', err);
  process.exit(1);
});
