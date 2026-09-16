-- 002_category_menu.sql
-- Derives the category/subcategory filter menu from condition_taxonomy
-- instead of a hardcoded object — this is what replaces the
-- `categories` block in trials.json with something that grows on its
-- own as new conditions get classified.

create view category_menu as
select
  category,
  category_label,
  jsonb_agg(distinct jsonb_build_object('subcategory', subcategory, 'subcategory_label', subcategory_label)) as subcategories,
  count(distinct raw_condition) as condition_count
from condition_taxonomy
group by category, category_label
order by category_label;

-- The frontend reads this view with the public anon key, so it needs
-- explicit read access — views don't inherit RLS the way tables do.
-- This is safe to expose: it's public reference data (category names),
-- nothing patient- or sponsor-sensitive.
grant select on category_menu to anon;

-- Frontend integration: applied in index.html's fetchCategoryMenu()
-- function, which fetches this view via Supabase's auto-generated
-- REST endpoint and reshapes it into the same object structure
-- renderCategoryChips()/renderSubcategoryChips()/validateConditions()
-- already expect — those functions themselves are unchanged.
-- GET {SUPABASE_URL}/rest/v1/category_menu?select=*
-- Header: apikey: <anon key>  (safe to expose client-side — read-only)
