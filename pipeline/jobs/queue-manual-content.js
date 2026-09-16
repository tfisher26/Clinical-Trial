import { db } from './lib/db.js';
import { appendNewEntries } from './lib/pendingQueue.js';

/**
 * queue-manual-content — no AI anywhere in this file. Three separate
 * queues, each with its own trigger logic:
 *
 *  - headline: queued for every new trial, same as summaries — this
 *    one is opportunistic ("write one whenever you like"), not
 *    gated on any detected condition.
 *  - qualifyNote: queued only when a deterministic rule fires
 *    (missing/short exclusion text, zero disqualify items despite
 *    exclusion text existing, or a keyword hit like "cohort").
 *  - extraCallout: queued only on a keyword hit for the kind of
 *    detail people commonly miss (study partner, washout, etc.).
 *
 * basics_extra is intentionally NOT auto-queued here — per the "B:
 * automatic + manual extras" decision, it's opt-in: add an entry to
 * pending-basics-extra/queue.md yourself whenever you want one,
 * apply-manual-edits.js will pick it up the same way either way.
 *
 * Known limitation: if you delete an unfilled entry from a queue
 * file to signal "no, this trial doesn't need one," that trial can
 * get re-queued on a later run if its trigger condition still holds
 * (there's no persistent "reviewed, skip" state). Low-severity — it
 * just means occasionally re-deciding something you already decided.
 */
const QUALIFY_NOTE_KEYWORDS = ['cohort', 'subgroup', 'stratum', 'stratified'];
const CALLOUT_KEYWORDS = [
  'study partner', 'caregiver', 'washout', 'biopsy',
  'weekly visit', 'twice weekly', 'twice a week', 'in-person visit each week',
  'overnight stay', 'inpatient',
];

async function main() {
  await queueHeadlines();
  await queueQualifyNotes();
  await queueCallouts();
}

async function queueHeadlines() {
  // Every trial that doesn't already have a headline set, and isn't
  // already sitting in the queue file.
  const { data: trials } = await db
    .from('trials_factual')
    .select('nct_id, official_name, official_link, trials_curated(headline)')
    .eq('status', 'RECRUITING');

  const candidates = (trials ?? []).filter((t) => !t.trials_curated?.[0]?.headline);

  const entries = candidates.map((t) => ({
    id: t.nct_id,
    block: `## ${t.nct_id}\nOfficial name: ${t.official_name}\nLink: ${t.official_link}\n\nHEADLINE:`,
  }));

  const header =
    '# Pending headlines\n\n' +
    'Optional — write a short, plain-language title for any trial you want one for ' +
    '(under HEADLINE:). Leave blank and it just uses the official name. Delete an ' +
    'entry you don\'t want to write one for; note it may reappear on a later run if ' +
    'still unresolved. Commit and push when done.';
  const added = appendNewEntries('pending-headlines/queue.md', entries, header);
  console.log(`queue-manual-content: ${added} headline candidate(s) queued.`);
}

async function queueQualifyNotes() {
  const { data: trials } = await db
    .from('trials_factual')
    .select('nct_id, official_name, exclusion_criteria, trials_curated(qualify_note)')
    .eq('status', 'RECRUITING');

  const entries = [];
  for (const t of trials ?? []) {
    if (t.trials_curated?.[0]?.qualify_note) continue; // already has one

    const { count: disqualifyCount } = await db
      .from('trials_criteria_extracted')
      .select('id', { count: 'exact', head: true })
      .eq('nct_id', t.nct_id)
      .eq('direction', 'disqualify');

    const exclusionText = t.exclusion_criteria || '';
    const tooShort = exclusionText.trim().length < 50;
    const zeroFound = !tooShort && (disqualifyCount ?? 0) === 0;
    const keywordHit = QUALIFY_NOTE_KEYWORDS.some((kw) => exclusionText.toLowerCase().includes(kw));

    if (tooShort || zeroFound || keywordHit) {
      const reason = tooShort ? 'exclusion text missing/short' : zeroFound ? 'no disqualify items extracted' : 'keyword match';
      entries.push({
        id: t.nct_id,
        block: `## ${t.nct_id}\n${t.official_name}\nTrigger: ${reason}\n\nExclusion criteria:\n"""\n${exclusionText || '(none)'}\n"""\n\nQUALIFY_NOTE:`,
      });
    }
  }

  const header =
    '# Pending qualify notes\n\n' +
    'Each trial below was flagged (see Trigger) as possibly needing a caveat under the ' +
    'qualify/disqualify lists. Write one under QUALIFY_NOTE: if warranted, or delete the ' +
    'entry if not needed. Commit and push when done.';
  const added = appendNewEntries('pending-qualify-notes/queue.md', entries, header);
  console.log(`queue-manual-content: ${added} qualify-note candidate(s) queued.`);
}

async function queueCallouts() {
  const { data: trials } = await db
    .from('trials_factual')
    .select('nct_id, official_name, inclusion_criteria, exclusion_criteria, trials_curated(extra_callout_text)')
    .eq('status', 'RECRUITING');

  const entries = [];
  for (const t of trials ?? []) {
    if (t.trials_curated?.[0]?.extra_callout_text) continue;

    const combinedText = `${t.inclusion_criteria || ''} ${t.exclusion_criteria || ''}`.toLowerCase();
    const hits = CALLOUT_KEYWORDS.filter((kw) => combinedText.includes(kw));
    if (!hits.length) continue;

    entries.push({
      id: t.nct_id,
      block:
        `## ${t.nct_id}\n${t.official_name}\nKeyword hit(s): ${hits.join(', ')}\n\n` +
        `Inclusion criteria:\n"""\n${t.inclusion_criteria || ''}\n"""\n` +
        `Exclusion criteria:\n"""\n${t.exclusion_criteria || ''}\n"""\n\n` +
        `CALLOUT_HEADING:\nCALLOUT_TEXT:`,
    });
  }

  const header =
    '# Pending callouts\n\n' +
    'Each trial below hit a keyword suggesting it may have a detail worth calling out ' +
    'prominently (see Keyword hit). Fill in CALLOUT_HEADING and CALLOUT_TEXT if warranted, ' +
    'or delete the entry if not. Commit and push when done.';
  const added = appendNewEntries('pending-callouts/queue.md', entries, header);
  console.log(`queue-manual-content: ${added} callout candidate(s) queued.`);
}

main().catch((err) => {
  console.error('queue-manual-content failed:', err);
  process.exit(1);
});
