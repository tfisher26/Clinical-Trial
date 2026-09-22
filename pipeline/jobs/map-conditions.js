import { db } from './lib/db.js';

/**
 * Joins classified conditions onto each trial and flags multi-category
 * trials for a relationship check.
 *
 * This used to loop over every trial in JS, issuing one UPDATE (and
 * sometimes a second upsert) per trial. Once the 1000-row query cap was
 * lifted that became ~60,000 sequential round-trips per run and blew
 * through the workflow's 90-minute budget before the queue steps ever
 * started. It is now a single RPC — see migrations/005.
 */
async function main() {
  const { data, error } = await db.rpc('map_trial_conditions');
  if (error) throw new Error(`map_trial_conditions failed: ${error.message}`);

  const { trials_updated = 0, trials_flagged = 0 } = data?.[0] ?? {};
  console.log(
    `map-conditions complete: ${trials_updated} trials updated, ${trials_flagged} flagged for relationship inference.`
  );
}

main().catch((err) => {
  console.error('map-conditions failed:', err);
  process.exit(1);
});
