-- 006_mesh_vocabulary.sql
--
-- Replaces per-string calls to the NLM MeSH API with a local copy of the
-- vocabulary. NLM publishes the full descriptor set for download exactly
-- so bulk consumers don't hammer the API:
--   https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/
--
-- This is not only faster, it is more correct. The API call in
-- classify-conditions.js searched descriptor NAMES with match=contains,
-- so entry-term synonyms were never consulted: "Breast Cancer" returned
-- only "Breast Cancer Lymphedema" (a lymphedema descriptor) and would
-- have been filed under Blood & Lymphatic. Matching against entry terms
-- resolves it to "Breast Neoplasms" under Cancer.

create extension if not exists pg_trgm;

-- ------------------------------------------------------------------
-- Vocabulary tables. Populated by jobs/load-mesh.js; refreshed only
-- when NLM publishes a new edition (annually), never in the daily run.
-- ------------------------------------------------------------------
create table if not exists mesh_descriptor (
  ui           text primary key,          -- e.g. D001943
  name         text not null,             -- preferred descriptor name
  tree_numbers text[] not null default '{}'
);

-- One row per entry term (synonym), normalized for matching. A single
-- descriptor has many: "Breast Neoplasms", "Breast Cancer",
-- "Cancer of the Breast", "Breast Carcinoma", ...
create table if not exists mesh_term (
  term_norm     text not null,
  descriptor_ui text not null references mesh_descriptor(ui) on delete cascade,
  is_preferred  boolean not null default false,
  -- MeSH's IsPermutedTermYN. Covers both useful variants ("Abdominal
  -- Neoplasm", singular) and mechanical inversions ("Neoplasms,
  -- Abdominal"). Kept for exact matching, ranked below non-permuted
  -- terms, and excluded from fuzzy matching where inversions would
  -- produce nonsense.
  is_permuted   boolean not null default false,
  primary key (term_norm, descriptor_ui)
);

create index if not exists idx_mesh_term_norm on mesh_term (term_norm);
create index if not exists idx_mesh_term_trgm on mesh_term using gin (term_norm gin_trgm_ops);

-- ------------------------------------------------------------------
-- Branch -> category map, lifted out of classify-conditions.js so the
-- classifier can run entirely in SQL. Edit here, not in the JS.
-- ------------------------------------------------------------------
create table if not exists mesh_branch_category (
  branch         text primary key,
  category       text not null,
  category_label text not null
);

insert into mesh_branch_category (branch, category, category_label) values
  ('C01','infectious','Infectious Disease'),
  ('C02','infectious','Infectious Disease'),
  ('C03','infectious','Infectious Disease'),
  ('C04','cancer','Cancer'),
  ('C05','musculoskeletal','Musculoskeletal'),
  ('C06','digestive','Digestive & GI'),
  ('C07','other','Other Conditions'),
  ('C08','respiratory','Respiratory'),
  ('C09','ent','Ear, Nose & Throat'),
  ('C10','neurological','Neurological'),
  ('C11','eye','Eye & Vision'),
  ('C12','renal','Kidney & Urologic'),
  ('C13','womens_health','Women''s Health'),
  ('C14','cardiovascular','Heart & Cardiovascular'),
  ('C15','blood','Blood & Lymphatic'),
  ('C16','genetic','Genetic & Congenital'),
  ('C17','skin','Skin & Connective Tissue'),
  ('C18','metabolic','Metabolic & Weight'),
  ('C19','metabolic','Metabolic & Weight'),
  ('C20','immune','Immune System & Autoimmune'),
  ('C21','other','Other Conditions'),
  ('C23','other','Other Conditions'),
  ('C24','other','Other Conditions'),
  ('C25','other','Other Conditions'),
  ('C26','other','Other Conditions'),
  ('F03','mental_health','Mental Health')
on conflict (branch) do update
  set category = excluded.category,
      category_label = excluded.category_label;

-- ------------------------------------------------------------------
-- Text helpers. Both are IMMUTABLE so they can be indexed.
-- ------------------------------------------------------------------
create or replace function mesh_normalize(s text) returns text
language sql immutable parallel safe as $fn$
  select trim(regexp_replace(lower(coalesce(s, '')), '[^a-z0-9]+', ' ', 'g'))
$fn$;

-- Mirrors slugify() in classify-conditions.js so subcategory ids stay
-- consistent with the 2,117 rows already classified via the old path.
create or replace function mesh_slugify(s text) returns text
language sql immutable parallel safe as $fn$
  select left(
    trim(both '_' from regexp_replace(lower(coalesce(s, '')), '[^a-z0-9]+', '_', 'g')),
    40
  )
$fn$;

-- ------------------------------------------------------------------
-- The classifier. Drains condition_taxonomy_pending in one statement.
--
-- p_min_similarity: when > 0, strings with no exact entry-term match
-- fall back to trigram similarity at that threshold. Pass 0 to disable
-- fuzzy matching entirely (exact only).
-- ------------------------------------------------------------------
create or replace function classify_pending_conditions(
  p_limit          int  default null,
  p_min_similarity real default 0
)
returns table (resolved bigint, still_pending bigint)
language plpgsql
as $fn$
declare
  v_resolved bigint;
begin
  create temp table _match on commit drop as
  with pending as (
    select p.raw_condition, mesh_normalize(p.raw_condition) as norm
      from condition_taxonomy_pending p
     limit p_limit
  ),
  -- Exact entry-term hits.
  exact as (
    select p.raw_condition, t.descriptor_ui, t.is_preferred, t.is_permuted,
           1.0::real as score
      from pending p
      join mesh_term t on t.term_norm = p.norm
  ),
  -- Trigram fallback, only for strings that got no exact hit.
  fuzzy as (
    select p.raw_condition, t.descriptor_ui, t.is_preferred, t.is_permuted,
           similarity(t.term_norm, p.norm) as score
      from pending p
      join mesh_term t
        on p_min_similarity > 0
       and not t.is_permuted
       and t.term_norm % p.norm
       and similarity(t.term_norm, p.norm) >= p_min_similarity
     where not exists (select 1 from exact e where e.raw_condition = p.raw_condition)
  ),
  candidate as (
    select * from exact
    union all
    select * from fuzzy
  ),
  ranked as (
    select
      c.raw_condition,
      d.name as descriptor_name,
      b.category,
      b.category_label,
      row_number() over (
        partition by c.raw_condition
        -- Best score, then the descriptor's own preferred term, then the
        -- most general (shortest) name, then ui for full determinism.
        order by c.score desc, c.is_permuted, c.is_preferred desc,
                 length(d.name), d.ui
      ) as rn
    from candidate c
    join mesh_descriptor d on d.ui = c.descriptor_ui
    join lateral (
      select mbc.category, mbc.category_label
        from unnest(d.tree_numbers) as tn
        join mesh_branch_category mbc on mbc.branch = split_part(tn, '.', 1)
       order by tn
       limit 1
    ) b on true
  )
  select raw_condition, descriptor_name, category, category_label
    from ranked where rn = 1;

  insert into condition_taxonomy
    (raw_condition, category, category_label, subcategory, subcategory_label, classified_by)
  select m.raw_condition, m.category, m.category_label,
         mesh_slugify(m.descriptor_name), m.descriptor_name, 'mesh_mapping'
    from _match m
  on conflict (raw_condition) do nothing;

  delete from condition_taxonomy_pending p
   where exists (select 1 from _match m where m.raw_condition = p.raw_condition);

  get diagnostics v_resolved = row_count;

  return query
    select v_resolved, (select count(*) from condition_taxonomy_pending);
end;
$fn$;
