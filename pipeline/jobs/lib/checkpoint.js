import fs from 'node:fs';
import path from 'node:path';

/**
 * Why this exists.
 *
 * The queue jobs used to clear a trial's flag in the database as soon as
 * they'd appended it to the local queue.md. But the queue files are only
 * committed at the very END of the workflow — so if the job was killed
 * partway (which is exactly what the 90-minute timeout was doing), the
 * flags were already cleared in Supabase while the file changes were
 * thrown away with the runner. Those trials were then invisible to every
 * future run: flagged as done, never actually queued.
 *
 * So: jobs now RECORD the ids they queued here, the workflow commits and
 * pushes the queue files, and only then does confirm-queued.js clear the
 * flags. Crash anywhere before the push and the flags stay set, so the
 * next run simply redoes the work.
 */

const DIR = '.queued';

export function recordQueued(job, column, ids) {
  if (!ids.length) return;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DIR, `${job}.json`),
    JSON.stringify({ job, column, ids }, null, 2),
    'utf-8'
  );
}

export function readCheckpoints() {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: path.join(DIR, f), ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8')) }));
}

export function clearCheckpoint(file) {
  fs.rmSync(file, { force: true });
}
