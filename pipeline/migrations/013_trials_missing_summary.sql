-- ============================================================
-- 013 — trials_missing_summary
--
-- The queue of trials needing a plain-language summary used to be
-- driven by trial_pending_generation.needs_summary. That flag is set
-- when a trial is synced and cleared when a job believes it handed the
-- trial over, and every summary bug we have hit has been a variation on
-- the flag being cleared when the work did not actually happen:
--
--   * flags cleared before the queue file was committed, runner then
--     died (fixed in lib/checkpoint.js, but trials lost in that window
--     stayed lost);
--   * apply-manual-edits saving row-by-row without checking errors and
--     running past the job timeout;
--   * generate-summaries filtering out trials with no intervention_raw
--     and then recording the whole chunk as queued anyway.
--
-- Once the flag is wrong nothing re-checks it, because the flag is the
-- only thing consulted. The database already knows which trials lack a
-- summary, so this view asks that question directly and becomes the
-- single source of truth. A trial lost to any past bug reappears here
-- on the next run on its own, so no repair script is needed.
-- ============================================================
create or replace view trials_missing_summary as
select
  f.nct_id,
  f.official_name,
  f.intervention_raw,
  f.official_link
from trials_factual f
left join trials_curated c on c.nct_id = f.nct_id
where f.delisted_at is null
  and coalesce(c.intervention_summary, '') = '';

grant select on trials_missing_summary to service_role;
