import { db } from './lib/db.js';

/**
 * map-conditions — runs after classify-conditions, once every raw
 * condition string a trial has is guaranteed to be in condition_taxonomy.
 * No AI here: pure lookup + join.
 *
 * Also flags trials whose conditions span MORE THAN ONE category for
 * relationship inference (see infer-relationship.js) — this is what
 * keeps that job's AI cost bounded to genuinely multi-condition
 * trials, not the whole registry.
 */
async function main() {
  // Only trials synced since last run realistically need remapping,
  // but re-deriving for all is cheap (pure DB read/write, no AI) and
  // simplest to reason about — this job is O(trials), not O(AI calls).
  const { data: trials } = await db.from('trials_factual').select('nct_id, raw_conditions, conditions');
  if (!trials?.length) return;

  const { data: taxonomyRows } = await db.from('condition_taxonomy').select('*');
  const taxonomy = new Map((taxonomyRows ?? []).map((r) => [r.raw_condition, r]));

  let updated = 0;
  let flaggedForRelationship = 0;

  for (const trial of trials) {
    const mapped = (trial.raw_conditions ?? [])
      .map((raw) => taxonomy.get(raw))
      .filter(Boolean)
      .map((t) => ({ category: t.category, subcategory: t.subcategory }));

    if (!mapped.length) continue; // still waiting on classification

    const distinctPairs = new Set(mapped.map((m) => `${m.category}|${m.subcategory}`));
    const spansMultipleCategories = new Set(mapped.map((m) => m.category)).size > 1
      || distinctPairs.size > 1;

    const currentJson = JSON.stringify(trial.conditions ?? []);
    const newJson = JSON.stringify(mapped);
    if (currentJson !== newJson) {
      await db.from('trials_factual').update({ conditions: mapped }).eq('nct_id', trial.nct_id);
      updated++;
    }

    if (spansMultipleCategories) {
      await db.from('trial_pending_generation').upsert(
        { nct_id: trial.nct_id, needs_relationship_check: true, flagged_at: new Date().toISOString() },
        { onConflict: 'nct_id' }
      );
      flaggedForRelationship++;
    }
  }

  console.log(`map-conditions complete: ${updated} trials updated, ${flaggedForRelationship} flagged for relationship inference.`);
}

main().catch((err) => {
  console.error('map-conditions failed:', err);
  process.exit(1);
});
