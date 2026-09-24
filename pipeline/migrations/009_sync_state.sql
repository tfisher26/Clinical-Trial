-- 009_sync_state.sql
-- Lets sync-trials.js ask ClinicalTrials.gov only for trials updated since
-- its last successful run, instead of re-downloading and rewriting all
-- ~65k recruiting trials every night.
--
-- One row. last_success_date is advanced only when a daily run finishes
-- with every write succeeding, so a failed or skipped night is covered by
-- the next run automatically.
--
-- Seeded with yesterday's date: the old full sync had already brought
-- every trial up to date when this was deployed, so the first incremental
-- run only needs to catch up from there (with its 1-day overlap).
--
-- Run this BEFORE deploying the matching sync-trials.js.

create table if not exists sync_state (
  id                int primary key default 1 check (id = 1),
  last_success_date date not null,
  updated_at        timestamptz not null default now()
);

insert into sync_state (id, last_success_date)
values (1, current_date - 1)
on conflict (id) do nothing;

-- Internal bookkeeping only. RLS on with no policies means the public anon
-- key can't read or change it; the service role used by the jobs bypasses RLS.
alter table sync_state enable row level security;
