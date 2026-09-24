import fs from 'node:fs';
import path from 'node:path';
import { db, fetchAll } from './lib/db.js';
import { readQueue, writeQueue, parseEntries, removeEntries } from './lib/pendingQueue.js';

/**
 * generate-summaries — keeps the pending-summaries queue files in step
 * with the database. No AI. Every live trial without a plain-language
 * summary appears in a queue file; every trial that has one does not.
 *
 * This used to be driven by trial_pending_generation.needs_summary, and
 * every summary bug we hit came from that flag being cleared when the work
 * had not actually happened — nothing ever re-checked it. The job now asks
 * the database the real question, via trials_missing_summary (migration
 * 013), so it is self-correcting: a trial lost to any past bug reappears on
 * the next run by itself, and a crash mid-run loses nothing.
 *
 * The backlog is too large for one file (62k entries is roughly 42 MB,
 * which git handles badly and the GitHub web editor will not open), so
 * entries are spread across numbered chunks of CHUNK_SIZE:
 *
 *   pending-summaries/queue-001.md
 *   pending-summaries/queue-002.md
 *   ...
 *
 * Fill in the SUMMARY: lines in any of them, commit, and push.
 * apply-manual-edits.js writes them to the database and removes the
 * entries it applied. Writing guidance is in jobs/prompts/summary-style.md.
 */

const QUEUE_DIR = 'pending-summaries';
const CHUNK_SIZE = 2000;
const FILE_RE = /^queue(-\d+)?\.md$/;

const HEADER =
  '# Pending intervention summaries\n\n' +
  'For each trial below, write a plain-language summary of what the trial is ' +
  'testing under SUMMARY:. See jobs/prompts/summary-style.md for the style to ' +
  'follow. Commit and push when done — completed entries are written to the ' +
  'database and removed from this file automatically. Entries you have not ' +
  'filled in are left alone.';

const chunkPath = (n) => path.join(QUEUE_DIR, `queue-${String(n).padStart(3, '0')}.md`);

/** Existing queue files, oldest-numbered first. Includes the legacy queue.md. */
function existingFiles() {
  if (!fs.existsSync(QUEUE_DIR)) return [];
  return fs
    .readdirSync(QUEUE_DIR)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((f) => path.join(QUEUE_DIR, f));
}

function entryBlock(t) {
  return (
    `## ${t.nct_id}\n${t.official_name}\n\n` +
    `Intervention: ${t.intervention_raw}\n` +
    `Link: ${t.official_link}\n\nSUMMARY:`
  );
}

function countEntries(content) {
  return (content.match(/^## /gm) ?? []).length;
}

async function main() {
  // The whole answer, in one read. Ids AND the text needed to write an
  // entry, so nothing has to be fetched a second time for the new ones.
  const missing = await fetchAll(() =>
    db.from('trials_missing_summary').select('nct_id, official_name, intervention_raw, official_link')
  );
  const missingIds = new Set(missing.map((r) => r.nct_id));
  console.log(`generate-summaries: ${missingIds.size} live trial(s) have no summary.`);

  // ---- 1. Drop anything that now has a summary -------------------------
  const files = existingFiles();
  const listed = new Set();
  let removed = 0;

  for (const file of files) {
    const content = readQueue(file);
    if (!content.trim()) continue;

    const ids = parseEntries(content, ['SUMMARY']).map((e) => e.id).filter(Boolean);
    const stale = ids.filter((id) => !missingIds.has(id));

    if (stale.length) {
      writeQueue(file, removeEntries(content, stale));
      removed += stale.length;
    }
    for (const id of ids) if (missingIds.has(id)) listed.add(id);
  }
  if (removed) console.log(`generate-summaries: removed ${removed} entr(ies) that now have summaries.`);

  // ---- 2. Add anything missing that is not already listed --------------
  const toAdd = missing.filter((t) => !listed.has(t.nct_id));
  if (!toAdd.length) {
    console.log('generate-summaries: queue files already match the database.');
    return;
  }
  console.log(`generate-summaries: adding ${toAdd.length} new entr(ies).`);

  // Top up the last chunk before starting a new one, so files stay dense
  // and entry-to-file mapping is stable between runs.
  const numbered = files.filter((f) => /queue-\d+\.md$/.test(f));
  let index = numbered.length || 1;
  let content = numbered.length ? readQueue(chunkPath(index)) : '';
  if (!content.trim()) content = `${HEADER}\n\n`;
  let count = countEntries(content);

  let written = 0;
  for (const trial of toAdd) {
    if (count >= CHUNK_SIZE) {
      writeQueue(chunkPath(index), content);
      written++;
      index++;
      content = `${HEADER}\n\n`;
      count = 0;
    }
    content += `${entryBlock(trial)}\n\n`;
    count++;
  }
  writeQueue(chunkPath(index), content);
  written++;

  console.log(`generate-summaries: wrote ${written} file(s), through ${chunkPath(index)}.`);
}

main().catch((err) => {
  console.error('generate-summaries failed:', err);
  process.exit(1);
});
