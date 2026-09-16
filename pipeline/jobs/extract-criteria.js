import { db } from './lib/db.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

/**
 * extract-criteria — the Option 1 pipeline agreed on for eligibility.
 *
 * The model's job is deliberately narrow: split raw criteria text
 * into atomic items and lightly reword EACH ONE IN ISOLATION. It is
 * never asked to synthesize across items (e.g. "both conditions
 * required" is NOT something this job can produce — that comes from
 * the structural `condition_relationship` field via a fixed template,
 * set separately, not from free generation here).
 *
 * Every extracted item is verified against the source text before
 * being written: if the model's `source_span` isn't a real substring
 * of the raw criteria, that item is dropped rather than trusted.
 * This is what makes the extraction safe to run with no human review.
 */
async function main() {
  const { data: pending } = await db
    .from('trial_pending_generation')
    .select('nct_id')
    .eq('needs_extraction', true);

  if (!pending?.length) {
    console.log('extract-criteria: nothing pending.');
    return;
  }

  console.log(`extract-criteria: ${pending.length} trials to process.`);

  for (const { nct_id } of pending) {
    try {
      await processOne(nct_id);
    } catch (err) {
      console.error(`extract-criteria failed for ${nct_id}:`, err.message);
      // Record the failed attempt so it's visible for follow-up; the trial
      // simply stays flagged (needs_extraction unchanged) and gets retried
      // on the next run rather than silently dropping out of the queue.
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
    }
  }
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

  // Replace old extraction rows for this trial, if any (hash changed).
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
