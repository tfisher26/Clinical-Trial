import { db, criteriaHash } from './lib/db.js';
import { iterateRecruitingTrials } from './lib/ctgov.js';

/**
 * sync-trials — runs daily, no AI calls. Sub-chunks database calls
 * into groups of 100 (not the full 1,000-trial CT.gov page at once)
 * to avoid oversized requests that can hang instead of failing
 * cleanly. Logs progress at each stage so a future stall is easy to
 * pinpoint instead of showing zero output.
 */
async function main() {
  console.log('sync-trials: starting, fetching first page from ClinicalTrials.gov...');
  let seen = 0;
  let flaggedNew = 0;
  let flaggedChanged = 0;
  const unseenConditions = new Set();

  for await (const batch of iterateRecruitingTrials()) {
    if (!batch.length) continue;
    console.log(`  fetched page of ${batch.length} trials from ClinicalTrials.gov, writing to database...`);
    seen += batch.length;

    const DB_CHUNK = 100;
    for (let i = 0; i < batch.length; i += DB_CHUNK) {
      const chunk = batch.slice(i, i + DB_CHUNK);
      const ids = chunk.map((t) => t.nct_id);

      const { data: existingRows, error: selectErr } = await db
        .from('trials_factual')
        .select('nct_id, criteria_hash')
        .in('nct_id', ids);
      if (selectErr) {
        console.error(`Failed to look up existing hashes for chunk:`, selectErr.message);
        continue;
      }
      const existingMap = new Map((existingRows ?? []).map((r) => [r.nct_id, r.criteria_hash]));

      const now = new Date().toISOString();
      const rows = chunk.map((trial) => ({
        ...trial,
        criteria_hash: criteriaHash(trial),
        last_synced_at: now,
      }));

      const { error: upsertErr } = await db.from('trials_factual').upsert(rows, { onConflict: 'nct_id' });
      if (upsertErr) {
        console.error(`Failed to upsert chunk of ${rows.length} trials:`, upsertErr.message);
        continue;
      }

      const toFlag = [];
      for (const trial of chunk) {
        const hash = criteriaHash(trial);
        if (!existingMap.has(trial.nct_id)) {
          flaggedNew++;
          toFlag.push(trial.nct_id);
        } else if (existingMap.get(trial.nct_id) !== hash) {
          flaggedChanged++;
          toFlag.push(trial.nct_id);
        }
        for (const c of trial.raw_conditions) unseenConditions.add(c);
      }

      if (toFlag.length) {
        await db.from('trial_pending_generation').upsert(
          toFlag.map((nct_id) => ({
            nct_id,
            needs_extraction: true,
            needs_summary: true,
            flagged_at: now,
          })),
          { onConflict: 'nct_id' }
        );
      }

      console.log(`  processed chunk: ${chunk.length} trials (${Math.min(i + DB_CHUNK, batch.length)}/${batch.length} of this page, ${seen} total seen so far)`);
    }
  }

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

main().catch((err) => {
  console.error('sync-trials failed:', err);
  process.exit(1);
});
