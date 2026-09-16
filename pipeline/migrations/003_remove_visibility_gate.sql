-- 003_remove_visibility_gate.sql
-- Previously, trials_public only showed a trial once BOTH extraction and
-- a summary existed. That gate is removed: every recruiting trial now
-- shows immediately, with intervention_summary simply null until you've
-- written and pushed one via pending-summaries/queue.md. Same for
-- eligibility items in trials_criteria_extracted — the frontend should
-- fall back to showing raw inclusion/exclusion text when there are none
-- yet, rather than waiting.

drop view if exists trials_public;

create view trials_public as
select
  f.*,
  c.intervention_summary,
  c.generated_at as summary_generated_at
from trials_factual f
left join trials_curated c on c.nct_id = f.nct_id
where f.status = 'RECRUITING';

grant select on trials_public to anon;
