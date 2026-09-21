import { db, fetchAll } from './lib/db.js';
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
  const pending = await fetchAll(() =>
    db.from('trial_pending_generation').select('nct_id').eq('needs_summary', true)
  );

  if (!pending.length) {
    console.log('generate-summaries: nothing pending.');
    return;
  }

  let added = 0;
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

    await db.from('trial_pending_generation').update({ needs_summary: false }).in('nct_id', idChunk);

    console.log(`  processed ${Math.min(i + DB_CHUNK, pending.length)}/${pending.length}`);
  }

  console.log(`generate-summaries: ${added} trial(s) added to ${QUEUE_PATH}.`);
}

main().catch((err) => {
  console.error('generate-summaries failed:', err);
  process.exit(1);
});
