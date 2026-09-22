import { db, fetchAll, queueBatchLimit } from './lib/db.js';
import { recordQueued } from './lib/checkpoint.js';
import { appendNewEntries } from './lib/pendingQueue.js';

const QUEUE_PATH = 'pending-summaries/queue.md';
const HEADER =
  '# Pending intervention summaries\n\n' +
  'For each trial below, write a 1-2 sentence plain-language summary of what the ' +
  'trial is testing under SUMMARY:. Do not mention eligibility, only what is being ' +
  'tested and its general goal. Commit and push this file when done — resolved ' +
  'entries are picked up automatically and removed from this file.';
const DB_CHUNK = 100;

async function main() {
  const limit = queueBatchLimit();
  const pending = await fetchAll(
    () => db.from('trial_pending_generation').select('nct_id').eq('needs_summary', true),
    { max: limit }
  );

  if (!pending.length) {
    console.log('generate-summaries: nothing pending.');
    return;
  }

  console.log(`generate-summaries: processing ${pending.length} trial(s) this run (limit ${limit}).`);

  let added = 0;
  const queued = [];
  for (let i = 0; i < pending.length; i += DB_CHUNK) {
    const idChunk = pending.slice(i, i + DB_CHUNK).map((p) => p.nct_id);

    const { data: trials } = await db
      .from('trials_factual')
      .select('nct_id, official_name, intervention_raw, official_link')
      .in('nct_id', idChunk);

    const entries = (trials ?? [])
      .filter((t) => t.intervention_raw && t.intervention_raw.trim())
      .map((t) => ({
        id: t.nct_id,
        block: `## ${t.nct_id}\n${t.official_name}\n\nIntervention: ${t.intervention_raw}\nLink: ${t.official_link}\n\nSUMMARY:`,
      }));

    added += appendNewEntries(QUEUE_PATH, entries, HEADER);

    // Flags are NOT cleared here — see lib/checkpoint.js. They're cleared
    // by confirm-queued.js only after these file changes are pushed.
    queued.push(...idChunk);

    console.log(`  processed ${Math.min(i + DB_CHUNK, pending.length)}/${pending.length}`);
  }

  recordQueued('generate-summaries', 'needs_summary', queued);
  console.log(
    `generate-summaries: ${added} trial(s) added to ${QUEUE_PATH}; ` +
    `${queued.length} pending confirmation after push.`
  );
}

main().catch((err) => {
  console.error('generate-summaries failed:', err);
  process.exit(1);
});
