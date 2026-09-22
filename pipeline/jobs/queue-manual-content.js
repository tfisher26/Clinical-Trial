import { db, fetchAll, queueBatchLimit } from './lib/db.js';
import { recordQueued } from './lib/checkpoint.js';
import { appendNewEntries } from './lib/pendingQueue.js';

const QUALIFY_NOTE_KEYWORDS = ['cohort', 'subgroup', 'stratum', 'stratified'];
const CALLOUT_KEYWORDS = [
  'study partner', 'caregiver', 'washout', 'biopsy',
  'weekly visit', 'twice weekly', 'twice a week', 'in-person visit each week',
  'overnight stay', 'inpatient',
];
const DB_CHUNK = 100;

async function main() {
  const limit = queueBatchLimit();
  const pending = await fetchAll(
    () => db.from('trial_pending_generation').select('nct_id').eq('needs_manual_content_check', true),
    { max: limit }
  );

  if (!pending.length) {
    console.log('queue-manual-content: nothing pending.');
    return;
  }

  const allIds = pending.map((p) => p.nct_id);
  console.log(`queue-manual-content: checking ${allIds.length} flagged trial(s) this run (limit ${limit}).`);

  const queued = [];

  let headlineCount = 0;
  let qualifyNoteCount = 0;
  let calloutCount = 0;

  for (let i = 0; i < allIds.length; i += DB_CHUNK) {
    const idChunk = allIds.slice(i, i + DB_CHUNK);

    const { data: trials } = await db
      .from('trials_factual')
      .select('nct_id, official_name, official_link, inclusion_criteria, exclusion_criteria')
      .in('nct_id', idChunk);
    if (!trials?.length) continue;

    const { data: extractedRows } = await db
      .from('trials_criteria_extracted')
      .select('nct_id, direction')
      .in('nct_id', idChunk)
      .eq('direction', 'disqualify');
    const disqualifyCounts = new Map();
    (extractedRows ?? []).forEach((r) => disqualifyCounts.set(r.nct_id, (disqualifyCounts.get(r.nct_id) ?? 0) + 1));

    const headlineEntries = [];
    const qualifyNoteEntries = [];
    const calloutEntries = [];

    for (const t of trials) {
      headlineEntries.push({
        id: t.nct_id,
        block: `## ${t.nct_id}\nOfficial name: ${t.official_name}\nLink: ${t.official_link}\n\nHEADLINE:`,
      });

      const exclusionText = t.exclusion_criteria || '';
      const tooShort = exclusionText.trim().length < 50;
      const zeroFound = !tooShort && (disqualifyCounts.get(t.nct_id) ?? 0) === 0;
      const keywordHit = QUALIFY_NOTE_KEYWORDS.some((kw) => exclusionText.toLowerCase().includes(kw));
      if (tooShort || zeroFound || keywordHit) {
        const reason = tooShort ? 'exclusion text missing/short' : zeroFound ? 'no disqualify items extracted' : 'keyword match';
        qualifyNoteEntries.push({
          id: t.nct_id,
          block: `## ${t.nct_id}\n${t.official_name}\nTrigger: ${reason}\n\nExclusion criteria:\n"""\n${exclusionText || '(none)'}\n"""\n\nQUALIFY_NOTE:`,
        });
      }

      const combinedText = `${t.inclusion_criteria || ''} ${t.exclusion_criteria || ''}`.toLowerCase();
      const hits = CALLOUT_KEYWORDS.filter((kw) => combinedText.includes(kw));
      if (hits.length) {
        calloutEntries.push({
          id: t.nct_id,
          block:
            `## ${t.nct_id}\n${t.official_name}\nKeyword hit(s): ${hits.join(', ')}\n\n` +
            `Inclusion criteria:\n"""\n${t.inclusion_criteria || ''}\n"""\n` +
            `Exclusion criteria:\n"""\n${t.exclusion_criteria || ''}\n"""\n\n` +
            `CALLOUT_HEADING:\nCALLOUT_TEXT:`,
        });
      }
    }

    headlineCount += appendNewEntries(
      'pending-headlines/queue.md', headlineEntries,
      '# Pending headlines\n\nOptional — write a short, plain-language title for any trial you want one for (under HEADLINE:). Leave blank and it just uses the official name. Commit and push when done.'
    );
    qualifyNoteCount += appendNewEntries(
      'pending-qualify-notes/queue.md', qualifyNoteEntries,
      '# Pending qualify notes\n\nEach trial below was flagged (see Trigger) as possibly needing a caveat under the qualify/disqualify lists. Write one under QUALIFY_NOTE: if warranted, or delete the entry if not needed. Commit and push when done.'
    );
    calloutCount += appendNewEntries(
      'pending-callouts/queue.md', calloutEntries,
      '# Pending callouts\n\nEach trial below hit a keyword suggesting it may have a detail worth calling out prominently (see Keyword hit). Fill in CALLOUT_HEADING and CALLOUT_TEXT if warranted, or delete the entry if not. Commit and push when done.'
    );

    // Cleared by confirm-queued.js after the push — see lib/checkpoint.js.
    queued.push(...idChunk);

    console.log(`  processed ${Math.min(i + DB_CHUNK, allIds.length)}/${allIds.length} flagged trials`);
  }

  recordQueued('queue-manual-content', 'needs_manual_content_check', queued);
  console.log(
    `queue-manual-content complete: ${headlineCount} headline, ${qualifyNoteCount} qualify-note, ` +
    `${calloutCount} callout candidate(s) queued; ${queued.length} pending confirmation after push.`
  );
}

main().catch((err) => {
  console.error('queue-manual-content failed:', err);
  process.exit(1);
});
