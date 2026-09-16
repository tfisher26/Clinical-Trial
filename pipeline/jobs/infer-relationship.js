import { db } from './lib/db.js';
import { appendNewEntries } from './lib/pendingQueue.js';

const QUEUE_PATH = 'pending-relationships/queue.md';
const HEADER =
  '# Pending relationship checks\n\n' +
  'Each trial below spans more than one condition category. Read the inclusion ' +
  'criteria and decide: are ALL listed conditions required TOGETHER for one person ' +
  'to qualify (comorbidity), or are they separate/alternative eligible populations ' +
  '(independent)? Fill in RELATIONSHIP: comorbidity or RELATIONSHIP: independent. ' +
  'Leave blank and skip if unsure — it will stay queued. Commit and push when done.';

/**
 * infer-relationship — no AI. Queues multi-category trials into
 * pending-relationships/queue.md for a human "comorbidity or not"
 * call, instead of inferring it. This is a best-effort enrichment
 * (the comorbidity badge), not a gate on trial visibility — an
 * unresolved entry just means no badge shows yet, which is the safe
 * default either way.
 */
async function main() {
  const { data: pending } = await db
    .from('trial_pending_generation')
    .select('nct_id')
    .eq('needs_relationship_check', true);

  if (!pending?.length) {
    console.log('infer-relationship: nothing pending.');
    return;
  }

  const { data: trials } = await db
    .from('trials_factual')
    .select('nct_id, official_name, conditions, inclusion_criteria')
    .in('nct_id', pending.map((p) => p.nct_id));

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

  const added = appendNewEntries(QUEUE_PATH, entries, HEADER);

  await db
    .from('trial_pending_generation')
    .update({ needs_relationship_check: false })
    .in('nct_id', pending.map((p) => p.nct_id));

  console.log(`infer-relationship: ${added} trial(s) added to ${QUEUE_PATH}.`);
}

main().catch((err) => {
  console.error('infer-relationship failed:', err);
  process.exit(1);
});
