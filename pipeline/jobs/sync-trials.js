import { db, criteriaHash, fetchAll } from './lib/db.js';
import { iterateRecruitingTrials } from './lib/ctgov.js';

// Safeguards for de-listing (marking trials absent from today's complete
// answer as no longer recruiting). Inference from absence is riskier than
// recording what CT.gov actually told us, so a run only closes anything if
// every one of these holds. See migrations/007_delisting.sql.
const MIN_RECEIVED_FRACTION = 0.98; // must receive >= 98% of CT.gov's reported total
const MAX_CLOSE_FRACTION = 0.05;    // must not close more than 5% of current listings

async function main() {
  console.log('sync-trials: starting, fetching first page from ClinicalTrials.gov...');
  const runStart = new Date().toISOString();
  const stats = {};
  let seen = 0;
  let flaggedNew = 0;
  let flaggedChanged = 0;
  let hadWriteFailures = false;
  const unseenConditions = new Set();

  for await (const batch of iterateRecruitingTrials({ stats })) {
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
        hadWriteFailures = true;
        continue;
      }
      const existingMap = new Map((existingRows ?? []).map((r) => [r.nct_id, r.criteria_hash]));

      const now = new Date().toISOString();
      const rows = chunk.map((trial) => ({
        ...trial,
        criteria_hash: criteriaHash(trial),
        last_synced_at: now,
        delisted_at: null, // seen as recruiting today — clears any prior de-listing
      }));

      const { error: upsertErr } = await db.from('trials_factual').upsert(rows, { onConflict: 'nct_id' });
      if (upsertErr) {
        console.error(`Failed to upsert chunk of ${rows.length} trials:`, upsertErr.message);
        hadWriteFailures = true;
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
            needs_manual_content_check: true,
            flagged_at: now,
          })),
          { onConflict: 'nct_id' }
        );
      }

      console.log(`  processed chunk: ${chunk.length} trials (${Math.min(i + DB_CHUNK, batch.length)}/${batch.length} of this page, ${seen} total seen so far)`);
    }
  }

  const knownConditions = await fetchAll(() => db.from('condition_taxonomy').select('raw_condition'));
  const known = new Set(knownConditions.map((r) => r.raw_condition));
  const newConditions = [...unseenConditions].filter((c) => !known.has(c));

  if (newConditions.length) {
    await db.from('condition_taxonomy_pending').upsert(
      newConditions.map((raw_condition) => ({ raw_condition })),
      { onConflict: 'raw_condition', ignoreDuplicates: true }
    );
  }

  await delistMissingTrials({ runStart, seen, totalCount: stats.totalCount, hadWriteFailures });

  console.log(
    `sync-trials complete: ${seen} trials synced, ${flaggedNew} new, ${flaggedChanged} changed, ` +
    `${newConditions.length} new condition strings queued for classification.`
  );
}

/**
 * Marks trials that weren't touched by this run as no longer recruiting.
 * Reaching this point already means every page was walked without the
 * generator throwing (a thrown error rejects `main()` before this line runs)
 * — the three checks below are the rest of the safeguards from
 * migrations/007_delisting.sql. Any one failing skips de-listing entirely
 * and reports why; nothing is closed on partial information.
 */
async function delistMissingTrials({ runStart, seen, totalCount, hadWriteFailures }) {
  if (hadWriteFailures) {
    console.warn('sync-trials: skipping de-listing — one or more writes failed this run, so "untouched" is not trustworthy.');
    return;
  }

  if (typeof totalCount === 'number' && seen < totalCount * MIN_RECEIVED_FRACTION) {
    console.warn(
      `sync-trials: skipping de-listing — received ${seen}/${totalCount} trials ` +
      `(${((seen / totalCount) * 100).toFixed(1)}%), below the ${MIN_RECEIVED_FRACTION * 100}% floor.`
    );
    return;
  }
  if (typeof totalCount !== 'number') {
    console.warn('sync-trials: skipping de-listing — ClinicalTrials.gov did not report a total count to check completeness against.');
    return;
  }

  // Two separate count-style queries against trials_factual have hit Postgres
  // statement timeouts (57014) this week, on this job and independently on
  // map-conditions.js's map_trial_conditions() RPC — a pre-existing/DB-level
  // issue (stale planner stats or a tightened timeout after recent heavy
  // migrations), not something specific to a query shape. Rather than add a
  // third query fighting the same timeout, reuse ClinicalTrials.gov's own
  // totalCount (already fetched and validated above) as the denominator for
  // the 5% cap — comparing "trials this run would close" against "how many
  // ClinicalTrials.gov says are actually recruiting" is at least as
  // meaningful a safety check, and needs no extra database round trip.
  const candidates = await fetchAll(() =>
    db.from('trials_factual').select('nct_id').is('delisted_at', null).lt('last_synced_at', runStart)
  );

  if (!candidates.length) {
    console.log('sync-trials: de-listing check passed, nothing to close.');
    return;
  }

  const closeFraction = candidates.length / totalCount;
  if (closeFraction > MAX_CLOSE_FRACTION) {
    console.warn(
      `sync-trials: skipping de-listing — would close ${candidates.length}/${totalCount} ` +
      `listings (${(closeFraction * 100).toFixed(1)}%), above the ${MAX_CLOSE_FRACTION * 100}% cap. ` +
      `This usually means an upstream problem, not a normal day of trials closing.`
    );
    return;
  }

  const CLOSE_CHUNK = 500;
  const ids = candidates.map((c) => c.nct_id);
  for (let i = 0; i < ids.length; i += CLOSE_CHUNK) {
    const idChunk = ids.slice(i, i + CLOSE_CHUNK);
    const { error: closeErr } = await db
      .from('trials_factual')
      .update({ delisted_at: runStart })
      .in('nct_id', idChunk);
    if (closeErr) {
      console.error(`sync-trials: failed to de-list a chunk of ${idChunk.length} trials:`, closeErr.message);
    }
  }

  console.log(`sync-trials: de-listed ${ids.length} trial(s) not seen in today's complete recruiting list.`);
}

main().catch((err) => {
  console.error('sync-trials failed:', err);
  process.exit(1);
});
