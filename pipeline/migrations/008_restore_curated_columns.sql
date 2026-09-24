-- 008_restore_curated_columns.sql
-- Fixes a regression from 007_delisting.sql.
--
-- 007 rebuilt trials_public from the 003 definition, which predates
-- 004_manual_content_fields.sql. That silently dropped the hand-written
-- columns 004 had added to the view (headline, qualify_note,
-- extra_callout_heading, extra_callout_text, basics_extra). The data was
-- never touched — it is all still in trials_curated — but the site could
-- no longer see it, so headlines fell back to official names and notes,
-- callouts and extra basics disappeared.
--
-- This is 004's column list with 007's filter. Nothing else changes.

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
where f.delisted_at is null;

grant select on trials_public to anon;
