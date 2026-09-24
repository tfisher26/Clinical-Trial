import { db, fetchAll, queueBatchLimit } from './lib/db.js';
import Anthropic from '@anthropic-ai/sdk';

// Stop after this many failures in a row. An auth error, an exhausted
// quota or a dead endpoint will not fix itself on the 40,000th attempt —
// and retrying is not free: every failure costs two further database
// round-trips to record it. On 2026-09-24 a missing API key sent this
// job through the whole pending set one trial at a time until the queue
// stage hit its 60-minute cap, so queue-manual-content and
// generate-summaries never ran at all.
const MAX_CONSECUTIVE_FAILURES = 10;

async function main() {
  // Fail fast rather than discovering this 56,000 trials later.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('extract-criteria: ANTHROPIC_API_KEY is not set — skipping.');
    return;
  }

  const limit = queueBatchLimit();
  const pending = await fetchAll(
    () => db.from('trial_pending_generation').select('nct_id').eq('needs_extraction', true),
    { max: limit }
  );

  if (!pending.length) {
    console.log('extract-criteria: nothing pending.');
    return;
  }

  console.log(`extract-criteria: ${pending.length} trial(s) this run (limit ${limit}).`);

  let done = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  for (const { nct_id } of pending) {
    try {
      await processOne(nct_id);
      done++;
      consecutiveFailures = 0;
    } catch (err) {
      failed++;
      consecutiveFailures++;
      console.error(`extract-criteria failed for ${nct_id}:`, err.message);

      const { data: current } = await db
        .from('trial_pending_generation')
        .select('attempt_count')
        .eq('nct_id', nct_id)
        .maybeSingle();
      await db
        .from('trial_pending_generation')
        .update({
          last_attempt_at: new Date().toISOString(),
          attempt_count: (current?.attempt_count ?? 0) + 1,
          last_error: err.message,
        })
        .eq('nct_id', nct_id);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `extract-criteria: ${consecutiveFailures} consecutive failures — aborting. ` +
          `Last error: ${err.message}`
        );
        break;
      }
    }
  }

  console.log(`extract-criteria: ${done} extracted, ${failed} failed.`);
}

async function processOne(nct_id) {
  const { data: trial, error } = await db
    .from('trials_factual')
    .select('nct_id, inclusion_criteria, exclusion_criteria, criteria_hash, condition_relationship')
    .eq('nct_id', nct_id)
    .single();
  if (error || !trial) throw new Error(`could not load trial: ${error?.message}`);

  const items = [
    ...(await extractSection(trial.inclusion_criteria, 'qualify')),
    ...(await extractSection(trial.exclusion_criteria, 'disqualify')),
  ];

  const verified = items.filter((item) => {
    const sourceText = item.direction === 'qualify' ? trial.inclusion_criteria : trial.exclusion_criteria;
    const ok = sourceText && sourceText.includes(item.source_span);
    if (!ok) console.warn(`  dropping unverifiable item for ${nct_id}: "${item.source_span}"`);
    return ok;
  });

  await db.from('trials_criteria_extracted').delete().eq('nct_id', nct_id);

  if (verified.length) {
    await db.from('trials_criteria_extracted').insert(
      verified.map((item) => ({
        nct_id,
        direction: item.direction,
        criterion_text: item.criterion_text,
        source_span: item.source_span,
        source_criteria_hash: trial.criteria_hash,
      }))
    );
  }

  await db
    .from('trial_pending_generation')
    .update({ needs_extraction: false, last_attempt_at: new Date().toISOString() })
    .eq('nct_id', nct_id);
}

async function extractSection(rawText, direction) {
  if (!rawText || !rawText.trim()) return [];

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content:
          `Below is raw eligibility criteria text from a clinical trial listing. Split it into ` +
          `individual, atomic criteria — one per distinct requirement. For EACH ONE INDIVIDUALLY, ` +
          `write a short plain-language sentence a layperson would understand. Do NOT combine, ` +
          `compare, or draw conclusions across multiple criteria — handle each one completely in ` +
          `isolation. "source_span" must be an EXACT, VERBATIM substring copied from the input text ` +
          `below (not paraphrased) that this criterion sentence was drawn from.\n\n` +
          `Respond with ONLY a JSON array, no other text:\n` +
          `[{"criterion_text": "plain language sentence", "source_span": "exact verbatim substring"}]\n\n` +
          `Raw text:\n"""${rawText}"""`,
      },
    ],
  });

  const text = msg.content.find((b) => b.type === 'text')?.text ?? '[]';
  let parsed;
  try {
    parsed = JSON.parse(text.trim().replace(/^```json\n?|```$/g, ''));
  } catch {
    console.warn(`  could not parse extraction response for direction=${direction}`);
    return [];
  }

  return parsed.map((p) => ({ ...p, direction }));
}

main().catch((err) => {
  console.error('extract-criteria failed:', err);
  process.exit(1);
});
