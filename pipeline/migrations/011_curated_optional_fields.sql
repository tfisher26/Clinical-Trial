-- 011_curated_optional_fields.sql
-- Lets trials_curated hold a headline, qualify note, callout or extra
-- basics for a trial that doesn't have a summary.
--
-- source_criteria_hash and model_used describe where a *summary* came from.
-- They were NOT NULL, so every headline / qualify-note / callout write
-- (which doesn't send them) was rejected — and apply-manual-edits.js
-- didn't check for errors, so 2,997 headlines were silently dropped.
-- They stay filled in for every summary; they're just optional otherwise.

alter table trials_curated alter column source_criteria_hash drop not null;
alter table trials_curated alter column model_used drop not null;
