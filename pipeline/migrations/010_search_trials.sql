-- 010_search_trials.sql
-- Lets the website search and page through trials in the database instead
-- of downloading every trial into the browser.
--
-- The site used to fetch all of trials_public on load and filter it in the
-- browser. That was built for a few dozen trials; at ~65k it either gets
-- cut off by the API row limit or downloads tens of MB per visit. Now the
-- site calls:
--
--   search_trials(p_query, p_categories, p_subpairs, p_after, p_limit)
--       → one page of trials_public rows, newest first
--   search_trials_count(p_query, p_categories, p_subpairs)
--       → how many trials match in total (called once per search)
--
-- Same matching rules as the old in-browser filter:
--   - p_categories: trial has a condition in ANY of these categories
--   - p_subpairs:   trial has ANY of these 'category|subcategory' pairs
--   - both given:   must satisfy both
--   - p_query:      every word must match the start of a word in the
--                   trial's official name, acronym, tags or headline
--                   ("diabet" finds "diabetes" and "diabetic")
--
-- Newest first = highest NCT number first. CT.gov assigns NCT numbers in
-- registration order, and nct_id is the primary key, so the sort is free.
-- Paging is keyset: pass the last nct_id you showed as p_after to get the
-- next page. That stays fast however deep someone scrolls, unlike
-- OFFSET, which gets slower the further down you go.
--
-- Adding the generated column rewrites trials_factual once (a few seconds,
-- during which the site's queries wait). A side benefit: the rewrite also
-- clears out the bloat from months of nightly full-table rewrites.

-- ------------------------------------------------------------------
-- 1. Search index over the searchable text
-- ------------------------------------------------------------------
-- 'simple' config: no stemming or stop words, so prefix matching behaves
-- like the old substring search on whole words.
alter table trials_factual
  add column if not exists search_tsv tsvector
  generated always as (
    to_tsvector('simple',
      coalesce(official_name, '') || ' ' ||
      coalesce(also_known_as, '') || ' ' ||
      coalesce(tags, ''))
  ) stored;

create index if not exists idx_trials_factual_search on trials_factual using gin (search_tsv);

-- Headlines live in trials_curated, so they get their own index.
alter table trials_curated
  add column if not exists headline_tsv tsvector
  generated always as (to_tsvector('simple', coalesce(headline, ''))) stored;

create index if not exists idx_trials_curated_headline on trials_curated using gin (headline_tsv);

-- ------------------------------------------------------------------
-- 2. Turn what the patient typed into a safe prefix query
-- ------------------------------------------------------------------
-- "Breast canc" -> 'breast:* & canc:*'. Punctuation is stripped, so
-- nothing typed into the search box can break the query syntax.
-- Returns null for an empty search.
create or replace function build_prefix_tsquery(p text)
returns tsquery
language sql
immutable
as $$
  select case when count(*) = 0 then null
              else to_tsquery('simple', string_agg(w || ':*', ' & '))
         end
  from regexp_split_to_table(
         lower(regexp_replace(coalesce(p, ''), '[^[:alnum:][:space:]]', ' ', 'g')),
         '\s+') as w
  where w <> ''
$$;

-- ------------------------------------------------------------------
-- 3. The shared filter
-- ------------------------------------------------------------------
-- Builds only the conditions a given search needs, so Postgres can pick
-- the fast path for each case: walking the primary key newest-first for
-- plain browsing, or the search index when there's a query. (One query
-- with every condition switched on/off by parameters was 5-10x slower in
-- testing, because Postgres has to plan for all of them at once.)
create or replace function _search_trials_from(
  p_has_query boolean,
  p_categories text[],
  p_subpairs   text[]
)
returns text
language plpgsql
immutable
as $$
declare
  s text := ' from trials_public p';
begin
  if p_has_query then
    -- Union of the two indexed matches, instead of an OR across tables,
    -- so both indexes are usable.
    s := s || ' join (select nct_id from trials_factual where search_tsv @@ $1'
            || ' union select nct_id from trials_curated where headline_tsv @@ $1) m'
            || ' on m.nct_id = p.nct_id';
  end if;
  s := s || ' where true';
  if coalesce(cardinality(p_categories), 0) > 0 then
    s := s || ' and exists (select 1 from jsonb_array_elements(p.conditions) x'
            || ' where x->>''category'' = any($2))';
  end if;
  if coalesce(cardinality(p_subpairs), 0) > 0 then
    s := s || ' and exists (select 1 from jsonb_array_elements(p.conditions) x'
            || ' where (x->>''category'') || ''|'' || (x->>''subcategory'') = any($3))';
  end if;
  return s;
end;
$$;

-- ------------------------------------------------------------------
-- 4. What the website calls
-- ------------------------------------------------------------------
-- Security definer so the public (anon) key can use the search indexes on
-- trials_factual/trials_curated without read access to those tables. Rows
-- only ever come back through trials_public (listed trials), which anon
-- can already read in full. Everything the patient typed is passed as a
-- bound parameter, never pasted into the SQL text.
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
  sql text := 'select p.*' || _search_trials_from(tsq is not null, p_categories, p_subpairs);
begin
  if p_after is not null then
    sql := sql || ' and p.nct_id < $4';
  end if;
  sql := sql || ' order by p.nct_id desc limit $5';
  return query execute sql
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
  execute 'select count(*)' || _search_trials_from(tsq is not null, p_categories, p_subpairs)
    into n
    using tsq, p_categories, p_subpairs;
  return n;
end;
$$;

-- Only the two site-facing functions are callable with the public key.
revoke execute on function _search_trials_from(boolean, text[], text[]) from public, anon, authenticated;
grant execute on function search_trials(text, text[], text[], text, int) to anon;
grant execute on function search_trials_count(text, text[], text[]) to anon;
