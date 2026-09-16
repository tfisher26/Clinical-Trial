import { db } from './lib/db.js';
import { appendNewEntries } from './lib/pendingQueue.js';

const QUEUE_PATH = 'pending-summaries/queue.md';
const HEADER =
  '# Pending intervention summaries\n\n' +
  'For each trial below, write a 1-2 sentence plain-language summary of what the ' +
  'trial is testing under SUMMARY:. Do not mention eligibility, only what is being ' +
  'tested and its general goal. Commit and push this file when done — resolved ' +
  'entries are picked up automatically and removed from this file.';

/**
 * generate-summaries — no AI call. Queues every trial needing a
 * summary into pending-summaries/queue.md for manual write-up, if
 * it isn't already queued. The needs_summary flag is cleared once
 * queued (the file itself is now the source of truth for "still
 * outstanding") — see apply-manual-edits.js for how filled-in
 * entries get written back to trials_curated.
 */
async function main() {
  const { data: pending } = await db
    .from('trial_pending_generation')
    .select('nct_id')
    .eq('needs_summary', true);

  if (!pending?.length) {
    console.log('generate-summaries: nothing pending.');
    return;
  }

  const { data: trials } = await db
    .from('trials_factual')
    .select('nct_id, official_name, intervention_raw, official_link')
    .in('nct_id', pending.map((p) => p.nct_id));

  const entries = (trials ?? [])
    .filter((t) => t.intervention_raw && t.intervention_raw.trim())
    .map((t) => ({
      id: t.nct_id,
      block: `## ${t.nct_id}\n${t.official_name}\n\nIntervention: ${t.intervention_raw}\nLink: ${t.official_link}\n\nSUMMARY:`,
    }));

  const added = appendNewEntries(QUEUE_PATH, entries, HEADER);

  await db
    .from('trial_pending_generation')
    .update({ needs_summary: false })
    .in('nct_id', pending.map((p) => p.nct_id));

  console.log(`generate-summaries: ${added} trial(s) added to ${QUEUE_PATH}.`);
}

main().catch((err) => {
  console.error('generate-summaries failed:', err);
  process.exit(1);
});
