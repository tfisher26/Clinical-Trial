-- 001_init.sql
-- Two-tier trial data architecture: factual (auto, no review) + curated (AI narrative, no review)
-- Run this once against a fresh Supabase/Postgres project.

-- ============================================================
-- Dynamic condition taxonomy — replaces the hardcoded categories
-- object in trials.json. Grows automatically as new condition
-- strings appear in ClinicalTrials.gov data; never hand-maintained.
-- ============================================================
create table condition_taxonomy (
  raw_condition   text primary key,       -- exact condition string from CT.gov
  category        text not null,          -- e.g. 'cancer'
  category_label  text not null,          -- e.g. 'Cancer'
  subcategory     text not null,          -- e.g. 'breast'
  subcategory_label text not null,        -- e.g. 'Breast Cancer'
  classified_by   text not null check (classified_by in ('mesh_mapping', 'ai_fallback', 'manual')),
  classified_at   timestamptz not null default now()
);

-- Queue of condition strings seen in a sync but not yet classified.
-- Keyed by distinct string, not by trial — this is what keeps
-- classification cost proportional to vocabulary size, not trial count.
create table condition_taxonomy_pending (
  raw_condition text primary key,
  flagged_at    timestamptz not null default now()
);

-- ============================================================
-- Factual layer — mirrored directly from ClinicalTrials.gov.
-- No AI, no review needed, fully automated daily sync.
-- ============================================================
create table trials_factual (
  nct_id                text primary key,
  official_name         text not null,
  also_known_as         text,
  status                text not null,
  phase                 text,
  masking               text,                 -- 'Double-blind' | 'Single-blind' | 'Open-label' etc
  sponsor               text,
  raw_conditions        text[] not null default '{}',   -- condition strings as CT.gov reports them
  conditions            jsonb not null default '[]',    -- [{category, subcategory}], derived via condition_taxonomy
  condition_relationship text,               -- 'comorbidity' when >1 condition required together
  locations             jsonb not null default '{}',    -- {group_label, sites: [], note, contact}
  site_scope            text,                -- short summary string, e.g. "35 sites · US, Argentina, Canada"
  age_min               integer,
  age_max               integer,
  sex                   text,
  inclusion_criteria    text,                -- raw text from CT.gov, unedited
  exclusion_criteria    text,                -- raw text from CT.gov, unedited
  intervention_raw      text,                -- raw "what's being studied" text from CT.gov
  tags                  text,                -- derived search keywords (not authored)
  criteria_hash         text not null,       -- hash of intervention_raw + inclusion/exclusion text
  official_link         text not null,
  last_synced_at        timestamptz not null default now()
);

create index idx_trials_factual_status on trials_factual (status);
create index idx_trials_factual_conditions on trials_factual using gin (conditions);

-- ============================================================
-- Extracted criteria — Option 1 from spec discussion.
-- Each row is ONE atomic criterion extracted from raw text,
-- never a synthesis across multiple criteria. The only
-- cross-criteria logic (e.g. "both conditions required") comes
-- from condition_relationship above, rendered via a fixed
-- template, not generated prose.
-- ============================================================
create table trials_criteria_extracted (
  id                   bigint generated always as identity primary key,
  nct_id               text not null references trials_factual(nct_id) on delete cascade,
  direction            text not null check (direction in ('qualify', 'disqualify')),
  criterion_text       text not null,        -- templated plain-language sentence
  source_span          text not null,        -- exact substring of raw criteria this came from
  source_criteria_hash text not null,        -- criteria_hash this extraction was generated from
  generated_at         timestamptz not null default now()
);

create index idx_criteria_extracted_nct on trials_criteria_extracted (nct_id);

-- ============================================================
-- Curated layer — the ONLY table with freely-generated AI prose.
-- Narrowly scoped to "what is this trial testing" — no
-- qualify/disqualify decision rides on this field.
-- ============================================================
create table trials_curated (
  nct_id               text primary key references trials_factual(nct_id) on delete cascade,
  intervention_summary text not null,
  source_criteria_hash text not null,        -- criteria_hash this summary was generated from
  model_used           text not null,
  generated_at         timestamptz not null default now()
);

-- ============================================================
-- Work queue — flags trials needing generation. A trial is only
-- visible on the site once it has no open flags AND has both
-- an extraction pass and a curated summary.
-- ============================================================
create table trial_pending_generation (
  nct_id            text primary key references trials_factual(nct_id) on delete cascade,
  needs_extraction  boolean not null default false,
  needs_summary     boolean not null default false,
  needs_classification boolean not null default false,
  needs_relationship_check boolean not null default false,
  flagged_at        timestamptz not null default now(),
  last_attempt_at   timestamptz,
  attempt_count     integer not null default 0,
  last_error        text
);

-- ============================================================
-- Site-facing view — this is what the website queries.
-- A trial only appears once fully processed (no open pending flags,
-- has extraction rows on both sides is not required if a trial
-- genuinely has zero disqualifying criteria, but a summary is
-- always required per the "no jargon-only trials" decision).
-- ============================================================
create view trials_public as
select
  f.*,
  c.intervention_summary,
  c.generated_at as summary_generated_at
from trials_factual f
inner join trials_curated c on c.nct_id = f.nct_id
where f.status = 'RECRUITING'
  and not exists (
    select 1 from trial_pending_generation p
    where p.nct_id = f.nct_id
      and (p.needs_extraction or p.needs_summary)
  );
