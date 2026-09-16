-- 004_manual_content_fields.sql

-- trials_curated becomes the home for ALL optional, human-authored
-- content layered on top of the factual record — not just the
-- summary. intervention_summary must become nullable since a trial
-- can now get a headline applied before (or without) ever getting a
-- summary — the visibility gate no longer requires both together.
alter table trials_curated alter column intervention_summary drop not null;

alter table trials_curated add column headline text;
alter table trials_curated add column qualify_note text;
alter table trials_curated add column extra_callout_heading text;
alter table trials_curated add column extra_callout_text text;
alter table trials_curated add column basics_extra jsonb not null default '[]'; -- array of {label, text}

-- Auto-derived, no AI — pulled directly from CT.gov structured data,
-- same pattern as tags.
alter table trials_factual add column enrollment_count integer;
alter table trials_factual add column duration_text text;

-- trials_public needs to expose the new trials_curated columns.
drop view if exists trials_public;

create view trials_public as
select
  f.*,
  c.intervention_summary,
  c.headline,
  c.qualify_note,
  c.extra_callout_heading,
  c.extra_callout_text,
  c.basics_extra,
  c.generated_at as summary_generated_at
from trials_factual f
left join trials_curated c on c.nct_id = f.nct_id
where f.status = 'RECRUITING';

grant select on trials_public to anon;
