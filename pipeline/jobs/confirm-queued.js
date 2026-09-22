import { db } from './lib/db.js';
import { readCheckpoints, clearCheckpoint } from './lib/checkpoint.js';

const DB_CHUNK = 100;

/**
 * Runs AFTER the queue files have been committed and pushed. Clears the
 * database flags for everything that made it into a committed queue
 * file. If the run died before the push, this never executes, the flags
 * stay set, and the next run re-queues the same trials — the queue files
 * de-duplicate by NCT id, so a repeat is harmless.
 */
async function main() {
  const checkpoints = readCheckpoints();
  if (!checkpoints.length) {
    console.log('confirm-queued: nothing to confirm.');
    return;
  }

  for (const { file, job, column, ids } of checkpoints) {
    for (let i = 0; i < ids.length; i += DB_CHUNK) {
      const chunk = ids.slice(i, i + DB_CHUNK);
      const { error } = await db
        .from('trial_pending_generation')
        .update({ [column]: false })
        .in('nct_id', chunk);
      if (error) throw new Error(`confirm-queued (${job}) failed: ${error.message}`);
    }
    clearCheckpoint(file);
    console.log(`confirm-queued: cleared ${column} for ${ids.length} trial(s) queued by ${job}.`);
  }
}

main().catch((err) => {
  console.error('confirm-queued failed:', err);
  process.exit(1);
});
