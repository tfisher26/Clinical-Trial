import { db, fetchAll, queueBatchLimit } from './lib/db.js';
import { recordQueued } from './lib/checkpoint.js';
import { appendNewEntries } from './lib/pendingQueue.js';

const QUEUE_PATH = 'pending-relationships/queue.md';
const HEADER =
  '# Pending relationship checks\n\n' +
  'Each trial below spans more than one condition category. Read the inclusion ' +
  'criteria and decide: are ALL listed conditions required TOGETHER for one person ' +
  'to qualify (comorbidity), or are they separate/alternative eligible populations ' +
  '(independent)? Fill in RELATIONSHIP: comorbidity or RELATIONSHIP: independent. ' +
  'Leave blank and skip if unsure — it will stay queued. Commit and push when done.';
const DB_CHUNK = 100;

async function main() {
  const limit = queueBatchLimit();
  const pending = await fetchAll(
    () => db.from('trial_pending_generation').select('nct_id').eq('needs_relationship_check', true),
    { max: limit }
  );

  if (!pending.length) {
    console.log('infer-relationship: nothing pending.');
    return;
  }

  console.log(`infer-relationship: processing ${pending.length} trial(s) this run (limit ${limit}).`);

  let added = 0;
  const queued = [];
  for (let i = 0; i < pending.length; i += DB_CHUNK) {
    const idChunk = pending.slice(i, i + DB_CHUNK).map((p) => p.nct_id);

    const { data: trials } = await db
      .from('trials_factual')
      .select('nct_id, official_name, conditions, inclusion_criteria')
      .in('nct_id', idChunk);

    const entries = (trials ?? [])
      .filter((t) => t.inclusion_criteria && t.inclusion_criteria.trim())
      .map((t) => {
        const conditionLabels = (t.conditions ?? []).map((c) => `${c.category}/${c.subcategory}`).join(', ');
        return {
          id: t.nct_id,
          block:
            `## ${t.nct_id}\n${t.official_name}\nConditions: ${conditionLabels}\n\n` +
            `Inclusion criteria:\n"""\n${t.inclusion_criteria}\n"""\n\nRELATIONSHIP:`,
        };
      });

    added += appendNewEntries(QUEUE_PATH, entries, HEADER);

    // Cleared by confirm-queued.js after the push — see lib/checkpoint.js.
    queued.push(...idChunk);

    console.log(`  processed ${Math.min(i + DB_CHUNK, pending.length)}/${pending.length}`);
  }

  recordQueued('infer-relationship', 'needs_relationship_check', queued);
  console.log(
    `infer-relationship: ${added} trial(s) added to ${QUEUE_PATH}; ` +
    `${queued.length} pending confirmation after push.`
  );
}

main().catch((err) => {
  console.error('infer-relationship failed:', err);
  process.exit(1);
});
