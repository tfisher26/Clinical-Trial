import { db } from './lib/db.js';

/**
 * Rebuilds trial_search, the small copy of trial data that the website's
 * search and counts read (migrations/012_trial_search_index.sql). Run after
 * any job that changes trials, conditions or headlines. Takes a few
 * seconds and doesn't block the site while it runs.
 */
async function main() {
  const started = Date.now();
  const { error } = await db.rpc('refresh_trial_search');
  if (error) throw new Error(`refresh_trial_search failed: ${error.message}`);
  console.log(`refresh-search: search index refreshed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
}

main().catch((err) => {
  console.error('refresh-search failed:', err);
  process.exit(1);
});
