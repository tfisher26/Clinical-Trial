import { db, criteriaHash } from './lib/db.js';
import { iterateRecruitingTrials } from './lib/ctgov.js';

/**
 * sync-trials — runs daily, no AI calls.
 * 1. Pulls every recruiting trial from ClinicalTrials.gov (paginated).
 * 2. Upserts factual data.
 * 3. Flags trials for extraction/summary/classification only when
 *    something that actually matters (criteria_hash) changed, or the
 *    trial is brand new — never re-flags unchanged trials.
 */
async function main() {
  let seen = 0;
  let flaggedNew = 0;
  let flaggedChanged = 0;
  const unseenConditions = new Set();

  for await (const trial of iterateRecruitingTrials()) {
    seen++;
    const hash = criteriaHash(trial);

    const { data: existing } = await db
      .from('trials_factual')
      .select('criteria_hash')
      .eq('nct_id', trial.nct_id)
      .maybeSingle();

    // Condition classification lookup happens here, cheaply — just a
    // set diff against strings already classified, no AI call unless
    // classify-conditions later finds something genuinely new.
    for (const c of trial.raw_conditions) unseenConditions.add(c);

    const { error: upsertErr } = await db.from('trials_factual').upsert(
      {
        ...trial,
        criteria_hash: hash,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: 'nct_id' }
    );
    if (upsertErr) {
      console.error(`Failed to upsert ${trial.nct_id}:`, upsertErr.message);
      continue;
    }

    if (!existing) {
      await flagPending(trial.nct_id, { needs_extraction: true, needs_summary: true });
      flaggedNew++;
    } else if (existing.criteria_hash !== hash) {
      await flagPending(trial.nct_id, { needs_extraction: true, needs_summary: true });
      flaggedChanged++;
    }
  }

  // Flag genuinely new condition strings for classification. Cheap:
  // this is a set of DISTINCT strings, not one row per trial.
  const { data: knownConditions } = await db.from('condition_taxonomy').select('raw_condition');
  const known = new Set((knownConditions ?? []).map((r) => r.raw_condition));
  const newConditions = [...unseenConditions].filter((c) => !known.has(c));

  if (newConditions.length) {
    await db.from('condition_taxonomy_pending').upsert(
      newConditions.map((raw_condition) => ({ raw_condition })),
      { onConflict: 'raw_condition', ignoreDuplicates: true }
    );
  }

  console.log(
    `sync-trials complete: ${seen} trials synced, ${flaggedNew} new, ${flaggedChanged} changed, ` +
    `${newConditions.length} new condition strings queued for classification.`
  );
}

async function flagPending(nct_id, flags) {
  await db.from('trial_pending_generation').upsert(
    { nct_id, ...flags, flagged_at: new Date().toISOString() },
    { onConflict: 'nct_id' }
  );
}

main().catch((err) => {
  console.error('sync-trials failed:', err);
  process.exit(1);
});
