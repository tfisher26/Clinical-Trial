import { db, criteriaHash, fetchAll } from './lib/db.js';
import { iterateUpdatedSince, iterateRecruitingIds, fetchTrialsByIds } from './lib/ctgov.js';

/**
 * Keeps trials_factual in step with ClinicalTrials.gov without re-downloading
 * or rewriting trials that haven't changed.
 *
 * DAILY — ask CT.gov only for trials updated since the last successful run
 * (typically 1–3 pages instead of ~65), in every status:
 *   - still RECRUITING   → write it; flag new/changed trials for follow-up.
 *   - anything else      → we already have it? record the real status CT.gov
 *                          sent and hide it (delisted_at). Observed, not
 *                          inferred, so no safeguards are needed.
 * The date of the last successful run lives in sync_state (migration 009),
 * so a failed or skipped night is caught up automatically.
 *
 * WEEKLY (Sundays UTC, or SYNC_FULL=true) — a light safety net. Download only
 * the ids of every recruiting trial, then:
 *   - fetch any we're missing,
 *   - re-list any we'd hidden that are recruiting again,
 *   - hide any we still show that aren't on the list — the same four
 *     safeguards as before, since this one IS inferred from absence.
 *
 * last_synced_at means "last time this row was written".
 */

// Daily: how far before the last successful run date to start. Update dates
// are day-level only, so a 1-day overlap catches updates posted after the
// last run on the same day. Re-writing that small overlap is harmless.
const OVERLAP_DAYS = 1;

// Weekly reconciliation safeguards (inference from absence).
const MIN_RECEIVED_FRACTION = 0.98;  // must receive >= 98% of CT.gov's reported total
const MAX_CLOSE_FRACTION = 0.05;     // must not close more than 5% of that total
const MIN_EXISTING_FRACTION = 0.9;   // our own read must look complete too

const WRITE_CHUNK = 250; // rows per upsert (POST body)
const ID_CHUNK = 200;    // ids per .in() filter (these go in the URL)

const today = () => new Date().toISOString().slice(0, 10);

function daysBefore(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { data: state, error: stateErr } = await db.from('sync_state').select('*').eq('id', 1).maybeSingle();
  if (stateErr) throw new Error(`Could not read sync_state: ${stateErr.message}`);
  if (!state?.last_success_date) {
    throw new Error('sync_state has no last_success_date. Run migrations/009_sync_state.sql first.');
  }

  const runDate = today();
  const conditions = new Set();

  const ok = await dailyUpdate({ since: daysBefore(state.last_success_date, OVERLAP_DAYS), conditions });

  const isSunday = new Date().getUTCDay() === 0;
  if (isSunday || process.env.SYNC_FULL === 'true') {
    await weeklyReconcile({ conditions });
  }

  await queueNewConditions(conditions);

  if (ok) {
    const { error } = await db
      .from('sync_state')
      .update({ last_success_date: runDate, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) throw new Error(`Could not record successful run: ${error.message}`);
    console.log(`sync-trials: recorded ${runDate} as the last successful run.`);
  } else {
    console.warn(
      `sync-trials: some writes failed, so the last successful run stays at ${state.last_success_date}. ` +
      `The next run will cover these updates again.`
    );
    process.exitCode = 1;
  }
}

/** Returns true if every write succeeded. */
async function dailyUpdate({ since, conditions }) {
  console.log(`sync-trials: fetching trials updated on or after ${since}...`);
  const stats = {};
  let received = 0;
  let written = 0;
  let flaggedNew = 0;
  let flaggedChanged = 0;
  let closed = 0;
  let allOk = true;

  for await (const batch of iterateUpdatedSince(since, { stats })) {
    if (!batch.length) continue;
    received += batch.length;

    // What do we already have for these trials?
    const known = new Map();
    for (let i = 0; i < batch.length; i += ID_CHUNK) {
      const ids = batch.slice(i, i + ID_CHUNK).map((t) => t.nct_id);
      const { data, error } = await db
        .from('trials_factual')
        .select('nct_id, criteria_hash, status, delisted_at')
        .in('nct_id', ids);
      if (error) throw new Error(`Failed to look up existing trials: ${error.message}`);
      for (const r of data ?? []) known.set(r.nct_id, r);
    }

    const now = new Date().toISOString();
    const toWrite = [];
    const toFlag = [];
    const closedByStatus = new Map(); // status -> [nct_id]

    for (const trial of batch) {
      const prev = known.get(trial.nct_id);

      if (trial.status === 'RECRUITING') {
        const cHash = criteriaHash(trial);
        if (!prev) {
          flaggedNew++;
          toFlag.push(trial.nct_id);
        } else if (prev.criteria_hash !== cHash) {
          flaggedChanged++;
          toFlag.push(trial.nct_id);
        }
        for (const c of trial.raw_conditions) conditions.add(c);
        toWrite.push({ ...trial, criteria_hash: cHash, last_synced_at: now, delisted_at: null });
      } else if (prev && (prev.status !== trial.status || !prev.delisted_at)) {
        // One we have that's no longer recruiting: record why, and hide it.
        if (!closedByStatus.has(trial.status)) closedByStatus.set(trial.status, []);
        closedByStatus.get(trial.status).push(trial.nct_id);
      }
      // Not recruiting and we never had it: nothing to do.
    }

    for (let i = 0; i < toWrite.length; i += WRITE_CHUNK) {
      const rows = toWrite.slice(i, i + WRITE_CHUNK);
      const { error } = await db.from('trials_factual').upsert(rows, { onConflict: 'nct_id' });
      if (error) {
        console.error(`Failed to write ${rows.length} trials:`, error.message);
        allOk = false;
        continue;
      }
      written += rows.length;
    }

    if (toFlag.length) {
      const { error } = await db.from('trial_pending_generation').upsert(
        toFlag.map((nct_id) => ({
          nct_id,
          needs_extraction: true,
          needs_summary: true,
          needs_manual_content_check: true,
          flagged_at: now,
        })),
        { onConflict: 'nct_id' }
      );
      if (error) {
        console.error(`Failed to flag ${toFlag.length} trials for follow-up:`, error.message);
        allOk = false;
      }
    }

    for (const [status, ids] of closedByStatus) {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        // Keep the first time it was hidden if it already was.
        const { error: statusErr } = await db.from('trials_factual').update({ status }).in('nct_id', chunk);
        const { error: hideErr } = await db
          .from('trials_factual')
          .update({ delisted_at: now })
          .in('nct_id', chunk)
          .is('delisted_at', null);
        if (statusErr || hideErr) {
          console.error(`Failed to record ${chunk.length} closed trials:`, (statusErr || hideErr).message);
          allOk = false;
          continue;
        }
        closed += chunk.length;
      }
    }

    console.log(`  page of ${batch.length}: ${toWrite.length} recruiting written, ${[...closedByStatus.values()].flat().length} closed`);
  }

  console.log(
    `sync-trials daily: ${received} updated trials received (CT.gov reported ${stats.totalCount ?? '?'}), ` +
    `${written} recruiting written (${flaggedNew} new, ${flaggedChanged} with changed criteria), ` +
    `${closed} no longer recruiting and hidden.`
  );
  return allOk;
}

async function weeklyReconcile({ conditions }) {
  console.log('sync-trials weekly: fetching the ids of every recruiting trial...');
  const stats = {};
  const seen = new Set();
  for await (const ids of iterateRecruitingIds({ stats })) for (const id of ids) seen.add(id);

  const existingRows = await fetchAll(() => db.from('trials_factual').select('nct_id, delisted_at'));
  const existing = new Map(existingRows.map((r) => [r.nct_id, r]));
  const total = stats.totalCount;

  if (typeof total !== 'number') {
    console.warn('sync-trials weekly: skipped — ClinicalTrials.gov did not report a total count.');
    return;
  }
  if (seen.size < total * MIN_RECEIVED_FRACTION) {
    console.warn(`sync-trials weekly: skipped — received ${seen.size}/${total} ids, below the ${MIN_RECEIVED_FRACTION * 100}% floor.`);
    return;
  }
  if (existing.size < total * MIN_EXISTING_FRACTION) {
    console.warn(`sync-trials weekly: skipped — read only ${existing.size} trials from our database against ${total} recruiting; the read looks truncated.`);
    return;
  }

  const now = new Date().toISOString();

  // Recruiting trials we don't have at all.
  const missing = [...seen].filter((id) => !existing.has(id));
  if (missing.length) {
    const trials = (await fetchTrialsByIds(missing)).filter((t) => t.status === 'RECRUITING');
    for (let i = 0; i < trials.length; i += WRITE_CHUNK) {
      const rows = trials.slice(i, i + WRITE_CHUNK).map((t) => {
        for (const c of t.raw_conditions) conditions.add(c);
        return { ...t, criteria_hash: criteriaHash(t), last_synced_at: now, delisted_at: null };
      });
      const { error } = await db.from('trials_factual').upsert(rows, { onConflict: 'nct_id' });
      if (error) { console.error(`Failed to add ${rows.length} missing trials:`, error.message); continue; }
      await db.from('trial_pending_generation').upsert(
        rows.map((r) => ({
          nct_id: r.nct_id, needs_extraction: true, needs_summary: true,
          needs_manual_content_check: true, flagged_at: now,
        })),
        { onConflict: 'nct_id' }
      );
    }
    console.log(`sync-trials weekly: added ${trials.length} recruiting trial(s) we were missing.`);
  }

  // Hidden trials that are recruiting again.
  const returning = [...seen].filter((id) => existing.get(id)?.delisted_at);
  for (let i = 0; i < returning.length; i += ID_CHUNK) {
    await db.from('trials_factual')
      .update({ delisted_at: null, status: 'RECRUITING' })
      .in('nct_id', returning.slice(i, i + ID_CHUNK));
  }
  if (returning.length) console.log(`sync-trials weekly: re-listed ${returning.length} trial(s) recruiting again.`);

  // Trials we still show that aren't on the recruiting list.
  const gone = [...existing.values()].filter((r) => !r.delisted_at && !seen.has(r.nct_id)).map((r) => r.nct_id);
  if (!gone.length) {
    console.log('sync-trials weekly: every listed trial is still recruiting.');
    return;
  }
  if (gone.length / total > MAX_CLOSE_FRACTION) {
    console.warn(
      `sync-trials weekly: skipped hiding — would hide ${gone.length}/${total} ` +
      `(${((gone.length / total) * 100).toFixed(1)}%), above the ${MAX_CLOSE_FRACTION * 100}% cap. ` +
      `This usually means an upstream problem, not a normal week of trials closing.`
    );
    return;
  }
  for (let i = 0; i < gone.length; i += ID_CHUNK) {
    const { error } = await db.from('trials_factual').update({ delisted_at: now }).in('nct_id', gone.slice(i, i + ID_CHUNK));
    if (error) console.error('Failed to hide a chunk of trials:', error.message);
  }
  console.log(`sync-trials weekly: hid ${gone.length} trial(s) no longer on the recruiting list.`);
}

async function queueNewConditions(conditions) {
  if (!conditions.size) return;
  const knownConditions = await fetchAll(() => db.from('condition_taxonomy').select('raw_condition'));
  const known = new Set(knownConditions.map((r) => r.raw_condition));
  const fresh = [...conditions].filter((c) => !known.has(c));
  if (fresh.length) {
    await db.from('condition_taxonomy_pending').upsert(
      fresh.map((raw_condition) => ({ raw_condition })),
      { onConflict: 'raw_condition', ignoreDuplicates: true }
    );
  }
  console.log(`sync-trials: ${fresh.length} unclassified condition string(s) from this run sent for classification.`);
}

main().catch((err) => {
  console.error('sync-trials failed:', err);
  process.exit(1);
});
