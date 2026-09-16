# Clinical Trial Guide — data pipeline

Two-tier architecture: `trials_factual` (mirrored from ClinicalTrials.gov,
zero AI) and `trials_curated` (one narrative field per trial, written by you).
Eligibility is handled via `trials_criteria_extracted` — atomic, verified
items, not free-generated prose.

**Only one job in this pipeline still calls the Anthropic API:
`extract-criteria.js`** (segmenting eligibility text, always verified
against the source before being written). Everything else — condition
classification, comorbidity detection, and intervention summaries — is
either free (MeSH lookup) or routed to you via a queue file in this repo.

## One-time setup

1. Create a Supabase project, run `migrations/001_init.sql` then
   `migrations/002_category_menu.sql` in the SQL editor.
2. Copy your project URL and **service role key** (Project Settings → API).
3. In GitHub: Settings → Secrets and variables → Actions, add
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `ANTHROPIC_API_KEY`
   (only needed for `extract-criteria.js`).
4. Commit this `pipeline/` folder to your repo, including both workflow
   files under `.github/workflows/`.
5. Trigger "Daily trial sync and generation" manually once (Actions tab →
   Run workflow) to check everything works before waiting for the schedule.

## What runs daily, in order

1. **`sync-trials.js`** — no AI. Pulls all recruiting trials, upserts facts,
   flags new/changed trials.
2. **`classify-conditions.js`** — free MeSH lookup only. Anything unmatched
   goes into `pending-categories/queue.md` for you to classify by hand.
3. **`map-conditions.js`** — no AI. Joins classified conditions onto each
   trial, flags multi-category trials for a relationship check.
4. **`infer-relationship.js`** — no AI. Queues multi-category trials into
   `pending-relationships/queue.md` for you to mark comorbidity or
   independent.
5. **`extract-criteria.js`** — the one AI step. Segments + verifies
   eligibility criteria into atomic, source-checked items. Unverifiable
   items are dropped, not trusted.
6. **`generate-summaries.js`** — no AI. Queues trials into
   `pending-summaries/queue.md` for you to write the plain-language
   "what's being tested" summary by hand.

The workflow commits any new queue entries back to the repo at the end
of the run.

## The three queue files

- **`pending-summaries/queue.md`** — fill in `SUMMARY:` under each trial.
- **`pending-categories/queue.md`** — fill in `CATEGORY:` /
  `CATEGORY_LABEL:` / `SUBCATEGORY:` / `SUBCATEGORY_LABEL:` for each
  unmatched condition string. Reuse an existing category id where listed —
  it's shown under each entry.
- **`pending-relationships/queue.md`** — fill in `RELATIONSHIP:` with
  either `comorbidity` or `independent` for each multi-category trial.

Edit any of these directly on GitHub.com or locally, then commit and push.
Pushing a change to any of these paths triggers the **"Apply manual queue
edits"** workflow automatically, which:
- reads every entry you've fully filled in,
- writes it to the database,
- removes it from the file,
- commits the trimmed file back.

Anything you haven't gotten to yet stays in the file, untouched, for next
time — there's no deadline and no batching required, edit as many or as
few entries as you want per commit.

## A trial only appears on the site once

**Update:** the summary-required gate has been removed
(`003_remove_visibility_gate.sql`). Every recruiting trial now shows
immediately after sync; `intervention_summary` is simply null until
you've written and pushed one via `pending-summaries/queue.md`. The
frontend should fall back to raw `inclusion_criteria`/`exclusion_criteria`
text when `trials_criteria_extracted` has no rows yet for a trial, rather
than waiting on that either.

**Important — this only matters once the frontend actually queries
`trials_public`.** Right now `index.html` still loads trial data from
`trials.json`, not Supabase — only the category menu was switched over
earlier. This migration is ready, but has no visible effect on the live
site until trial data itself is migrated to query `trials_public`, which
is a separate frontend change not yet built.

## Known open items

- **Queue file size**: if trial volume grows, `pending-summaries/queue.md`
  could get long. Nothing about the design requires one file — splitting
  by date or by category is a small change if it becomes unwieldy.
- **Retry backoff on `extract-criteria.js`**: failures leave the row
  flagged for retry next run, with `attempt_count`/`last_error` recorded.
  No alerting is wired up.
- **CT.gov rate limiting**: verified against current docs and independent
  sources (Sept 2026) — pageSize max 1000, pageToken cursor pagination,
  no published hard rate limit but ~50 req/min is the safe community norm,
  which `ctgov.js` paces to with 429/5xx retry+backoff.
