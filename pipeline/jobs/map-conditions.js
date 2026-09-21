import { db, fetchAll } from './lib/db.js';

async function main() {
  const trials = await fetchAll(() => db.from('trials_factual').select('nct_id, raw_conditions, conditions'));
  if (!trials.length) return;

  const taxonomyRows = await fetchAll(() => db.from('condition_taxonomy').select('*'));
  const taxonomy = new Map(taxonomyRows.map((r) => [r.raw_condition, r]));

  let updated = 0;
  let flaggedForRelationship = 0;

  for (const trial of trials) {
    const mapped = (trial.raw_conditions ?? [])
      .map((raw) => taxonomy.get(raw))
      .filter(Boolean)
      .map((t) => ({ category: t.category, subcategory: t.subcategory }));

    if (!mapped.length) continue;

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
