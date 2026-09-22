-- 005_pipeline_throughput.sql
--
-- Three changes, all aimed at letting the daily pipeline finish inside
-- its time budget now that the 1000-row query cap is gone:
--
--   1. Records `needs_manual_content_check`, which queue-manual-content.js
--      already depends on but which was never written into a migration —
--      a fresh Supabase project built from migrations alone would break.
--   2. Partial indexes on the work-queue flags, so draining the queue is
--      an index scan instead of a seq scan over the whole table.
--   3. Replaces the per-trial UPDATE loop in map-conditions.js with a
--      single set-based call. This is the actual fix for the 90-minute
--      workflow timeout: that loop was issuing ~60,000 sequential HTTP
--      round-trips per run.

-- ------------------------------------------------------------------
-- 1. Missing column
-- ------------------------------------------------------------------
alter table trial_pending_generation
  add column if not exists needs_manual_content_check boolean not null default false;

-- ------------------------------------------------------------------
-- 2. Partial indexes on the flags the queue jobs filter by.
--    Partial (WHERE flag) keeps them tiny — they only contain the rows
--    still outstanding, and shrink to nothing as the backlog drains.
-- ------------------------------------------------------------------
create index if not exists idx_tpg_needs_summary
  on trial_pending_generation (nct_id) where needs_summary;
create index if not exists idx_tpg_needs_extraction
  on trial_pending_generation (nct_id) where needs_extraction;
create index if not exists idx_tpg_needs_relationship
  on trial_pending_generation (nct_id) where needs_relationship_check;
create index if not exists idx_tpg_needs_manual_content
  on trial_pending_generation (nct_id) where needs_manual_content_check;

-- ------------------------------------------------------------------
-- 3. Set-based condition mapping
-- ------------------------------------------------------------------

-- One row per trial: its taxonomy-mapped conditions, plus the two
-- counts that decide whether it spans multiple categories. Exposed as
-- a view so it can be inspected directly when a mapping looks wrong.
create or replace view trial_condition_mapping as
select
  f.nct_id,
  coalesce(
    jsonb_agg(distinct jsonb_build_object(
      'category', t.category,
      'subcategory', t.subcategory
    )) filter (where t.raw_condition is not null),
    '[]'::jsonb
  )                                                              as mapped,
  count(distinct t.category)             filter (where t.raw_condition is not null) as n_categories,
  count(distinct (t.category, t.subcategory))
                                         filter (where t.raw_condition is not null) as n_pairs
from trials_factual f
left join lateral unnest(f.raw_conditions) as rc(raw_condition) on true
left join condition_taxonomy t on t.raw_condition = rc.raw_condition
group by f.nct_id;

-- Applies the view in two statements instead of 60,000 round-trips.
-- Returns the same two counters map-conditions.js used to log, so the
-- job's output is unchanged.
create or replace function map_trial_conditions()
returns table (trials_updated bigint, trials_flagged bigint)
language plpgsql
as $func$
declare
  v_updated bigint;
  v_flagged bigint;
begin
  -- Only touch rows whose mapping actually changed. `is distinct from`
  -- (not <>) so a null-vs-value difference counts as a change.
  with upd as (
    update trials_factual f
       set conditions = m.mapped
      from trial_condition_mapping m
     where f.nct_id = m.nct_id
       and m.mapped <> '[]'::jsonb          -- never blank out an existing mapping
       and f.conditions is distinct from m.mapped
    returning 1
  )
  select count(*) into v_updated from upd;

  with fl as (
    insert into trial_pending_generation (nct_id, needs_relationship_check, flagged_at)
    select m.nct_id, true, now()
      from trial_condition_mapping m
      join trials_factual f on f.nct_id = m.nct_id
     where (m.n_categories > 1 or m.n_pairs > 1)
       -- Don't re-ask about trials you've already ruled on. The old loop
       -- re-flagged every multi-category trial on every run, so resolved
       -- ones kept coming back around forever.
       and f.condition_relationship is null
    on conflict (nct_id) do update
      set needs_relationship_check = true,
          flagged_at = now()
    returning 1
  )
  select count(*) into v_flagged from fl;

  return query select v_updated, v_flagged;
end;
$func$;

-- NOTE: jsonb_agg(distinct ...) sorts and de-duplicates, whereas the old
-- JS loop preserved CT.gov's original order and kept duplicates. The
-- first run after this migration will therefore rewrite `conditions` for
-- most trials once, then settle — every run after that is a no-op for
-- unchanged trials.
