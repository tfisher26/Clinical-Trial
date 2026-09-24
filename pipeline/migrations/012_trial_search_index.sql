-- 012_trial_search_index.sql
-- Makes the site's searches and counts fast by keeping a small, narrow copy
-- of just what search needs, instead of reading trials_factual.
--
-- Why: each trial row carries pages of eligibility text and locations, so
-- trials_factual is ~200 MB. Counting "all trials" or "Cancer trials"
-- meant reading most of that from disk, which blew through the 3-second
-- limit for public visitors ("canceling statement due to statement
-- timeout"). This table holds one short row per LISTED trial — its id,
-- category list, category|subcategory list, and a search index over name,
-- acronym, tags and headline — a few MB that stays in memory.
--
-- It's a materialized view: a saved query result that's only recomputed
-- when refresh_trial_search() is called. The data only changes when the
-- pipeline runs, so the jobs refresh it after they write (sync, classify,
-- manual edits). Refreshing takes a few seconds and doesn't block the site
-- (CONCURRENTLY).
--
-- search_trials / search_trials_count keep the same inputs and outputs, so
-- the website doesn't need to change. Between a trial being hidden and the
-- next refresh, pages already skip it; counts may be off by that handful
-- until the refresh a few seconds later.

-- ------------------------------------------------------------------
-- 1. The narrow search table
-- ------------------------------------------------------------------
drop materialized view if exists trial_search;

create materialized view trial_search as
select
  f.nct_id,
  coalesce(array(select distinct x->>'category' from jsonb_array_elements(f.conditions) x), '{}') as categories,
  coalesce(array(select distinct (x->>'category') || '|' || (x->>'subcategory')
                 from jsonb_array_elements(f.conditions) x), '{}')                          as subpairs,
  f.search_tsv || to_tsvector('simple', coalesce(c.headline, ''))                            as search_tsv
from trials_factual f
left join trials_curated c on c.nct_id = f.nct_id
where f.delisted_at is null;

create unique index trial_search_nct_id on trial_search (nct_id);   -- also required for CONCURRENTLY
create index trial_search_categories on trial_search using gin (categories);
create index trial_search_subpairs   on trial_search using gin (subpairs);
create index trial_search_tsv        on trial_search using gin (search_tsv);

-- Only reachable through the functions below.
revoke all on trial_search from public, anon, authenticated;

-- ------------------------------------------------------------------
-- 2. Refresh, called by the pipeline jobs after they write
-- ------------------------------------------------------------------
create or replace function refresh_trial_search()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently trial_search;
  analyze trial_search;  -- keep row estimates current so the planner picks the right indexes
end;
$$;

revoke execute on function refresh_trial_search() from public, anon, authenticated;
grant execute on function refresh_trial_search() to service_role;

-- ------------------------------------------------------------------
-- 3. Search functions, now reading trial_search
-- ------------------------------------------------------------------
-- Same matching rules as 010:
--   categories: ANY selected category  (&& = "shares any element")
--   subpairs:   ANY selected category|subcategory pair
--   query:      every word matches the start of a word
-- Only the conditions a search needs are included, so each case can use
-- its index.
create or replace function _search_trials_where(
  p_has_query boolean,
  p_categories text[],
  p_subpairs   text[]
)
returns text
language plpgsql
immutable
as $$
declare
  s text := ' from trial_search s where true';
begin
  if p_has_query then
    s := s || ' and s.search_tsv @@ $1';
  end if;
  if coalesce(cardinality(p_categories), 0) > 0 then
    s := s || ' and s.categories && $2';
  end if;
  if coalesce(cardinality(p_subpairs), 0) > 0 then
    s := s || ' and s.subpairs && $3';
  end if;
  return s;
end;
$$;

create or replace function search_trials(
  p_query      text   default null,
  p_categories text[] default null,
  p_subpairs   text[] default null,
  p_after      text   default null,
  p_limit      int    default 25
)
returns setof trials_public
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  tsq tsquery := build_prefix_tsquery(p_query);
  ids text := 'select s.nct_id' || _search_trials_where(tsq is not null, p_categories, p_subpairs);
begin
  if p_after is not null then
    ids := ids || ' and s.nct_id < $4';
  end if;
  -- Shortlist the next page plus 20 spares from the narrow table, then
  -- drop any trial hidden since the last refresh (it's still in
  -- trial_search until then). Checking only the shortlist keeps this to a
  -- few dozen lookups instead of one per matching trial.
  ids := 'select c.nct_id from (' || ids || ' order by s.nct_id desc limit $5 + 20) c'
      || ' where not exists (select 1 from trials_factual f'
      || ' where f.nct_id = c.nct_id and f.delisted_at is not null)'
      || ' order by c.nct_id desc limit $5';
  -- Pick the page of ids from the narrow table, then fetch just those
  -- trials' full rows.
  return query execute
    'select p.* from trials_public p where p.nct_id in (' || ids || ') order by p.nct_id desc'
    using tsq, p_categories, p_subpairs, p_after,
          least(greatest(coalesce(p_limit, 25), 1), 100);
end;
$$;

create or replace function search_trials_count(
  p_query      text   default null,
  p_categories text[] default null,
  p_subpairs   text[] default null
)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  tsq tsquery := build_prefix_tsquery(p_query);
  n bigint;
begin
  execute 'select count(*)' || _search_trials_where(tsq is not null, p_categories, p_subpairs)
    into n
    using tsq, p_categories, p_subpairs;
  return n;
end;
$$;

-- 010's helper is no longer used.
drop function if exists _search_trials_from(boolean, text[], text[]);

revoke execute on function _search_trials_where(boolean, text[], text[]) from public, anon, authenticated;
grant execute on function search_trials(text, text[], text[], text, int) to anon;
grant execute on function search_trials_count(text, text[], text[]) to anon;
