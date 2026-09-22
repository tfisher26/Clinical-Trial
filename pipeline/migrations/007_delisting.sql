-- 007_delisting.sql
-- Adds de-listing: a trial that stops appearing in ClinicalTrials.gov's
-- recruiting list is hidden from the site without deleting or overwriting
-- its data.
--
-- Design: `status` keeps meaning "the last real value CT.gov sent us" and
-- is never touched by this. A separate `delisted_at` timestamp records our
-- own sync's confidence: null means "seen as recruiting in the most recent
-- complete sync", non-null means "missing as of that timestamp". The nightly
-- job clears it back to null the moment a trial reappears, so a paused/
-- resumed trial requires no manual re-listing.
--
-- trials_public now filters on delisted_at alone, decoupled from status,
-- so status remains free to be backfilled with the real closed reason later
-- (completed/terminated/suspended) without affecting what's shown.

alter table trials_factual add column delisted_at timestamptz;

-- Supports both the nightly "which trials weren't touched this run" query
-- and the safety check that gates it.
create index idx_trials_factual_last_synced_at on trials_factual (last_synced_at);

-- Partial index matches the trials_public filter exactly.
create index idx_trials_factual_delisted_at_null on trials_factual (nct_id) where delisted_at is null;

drop view if exists trials_public;

create view trials_public as
select
  f.*,
  c.intervention_summary,
  c.generated_at as summary_generated_at
from trials_factual f
left join trials_curated c on c.nct_id = f.nct_id
where f.delisted_at is null;

grant select on trials_public to anon;
