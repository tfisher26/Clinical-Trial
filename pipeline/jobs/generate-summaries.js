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

  // Every queue file is held in memory and written at most once, at the end.
  const files = existingFiles().map((file) => ({
    file,
    content: readQueue(file),
    count: 0,
    dirty: false,
  }));

  // ---- 1. Drop anything that now has a summary -------------------------
  const listed = new Set();
  let removed = 0;

  for (const f of files) {
    const ids = parseEntries(f.content, ['SUMMARY']).map((e) => e.id).filter(Boolean);
    const stale = ids.filter((id) => !missingIds.has(id));

    if (stale.length) {
      f.content = removeEntries(f.content, stale);
      f.dirty = true;
      removed += stale.length;
    }
    for (const id of ids) if (missingIds.has(id)) listed.add(id);
    f.count = countEntries(f.content);
  }
  if (removed) console.log(`generate-summaries: removed ${removed} entr(ies) that now have summaries.`);

  // ---- 2. Add anything missing that is not already listed --------------
  // Fill free space in existing files first, lowest number first, so space
  // freed by finished summaries is reused instead of new files piling up.
  // Existing entries are never moved between files: that would collide with
  // anyone part-way through filling one in. New entries are only appended.
  const pending = missing.filter((t) => !listed.has(t.nct_id));
  if (pending.length) console.log(`generate-summaries: adding ${pending.length} new entr(ies).`);

  const append = (f, batch) => {
    const base = f.content.trim() ? f.content.replace(/\s*$/, '\n\n') : `${HEADER}\n\n`;
    f.content = base + batch.map(entryBlock).join('\n\n') + '\n\n';
    f.count += batch.length;
    f.dirty = true;
  };

  // The legacy unnumbered queue.md is only drained, never refilled.
  const numbered = files.filter((f) => /queue-\d+\.md$/.test(f.file));
  for (const f of numbered) {
    if (!pending.length) break;
    const room = CHUNK_SIZE - f.count;
    if (room > 0) append(f, pending.splice(0, room));
  }

  // Only when every existing file is full: start new ones after the HIGHEST
  // existing number. (Using the file count here would overwrite an existing
  // file whenever an earlier one had been deleted.)
  let next = Math.max(0, ...numbered.map((f) => Number(f.file.match(/queue-(\d+)\.md$/)[1]))) + 1;
  while (pending.length) {
    const f = { file: chunkPath(next++), content: '', count: 0, dirty: false };
    append(f, pending.splice(0, CHUNK_SIZE));
    files.push(f);
  }

  // ---- 3. Write what changed; delete files left with no entries --------
  let written = 0;
  const deleted = [];
  for (const f of files) {
    if (f.count === 0) {
      fs.unlinkSync(f.file);
      deleted.push(path.basename(f.file));
    } else if (f.dirty) {
      writeQueue(f.file, f.content);
      written++;
    }
  }

  if (deleted.length) console.log(`generate-summaries: deleted ${deleted.length} empty file(s): ${deleted.join(', ')}.`);
  console.log(
    written || deleted.length
      ? `generate-summaries: updated ${written} file(s); ${files.length - deleted.length} queue file(s) remain.`
      : 'generate-summaries: queue files already match the database.'
  );
}

main().catch((err) => {
  console.error('generate-summaries failed:', err);
  process.exit(1);
});
