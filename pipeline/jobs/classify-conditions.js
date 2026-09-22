import { db, fetchAll, queueBatchLimit } from './lib/db.js';
import { appendNewEntries, readQueue, writeQueue, removeEntries } from './lib/pendingQueue.js';

const QUEUE_PATH = 'pending-categories/queue.md';

// Trigram threshold for strings with no exact entry-term match. 0 turns
// fuzzy matching off entirely. 0.55 was chosen empirically: it resolves
// "Achondroplasia in Children" -> Achondroplasia while still declining
// to guess on strings MeSH has no concept for.
const MIN_SIMILARITY = Number.parseFloat(process.env.MESH_MIN_SIMILARITY ?? '0.55');

/**
 * Classifies condition strings against the LOCAL MeSH vocabulary
 * (mesh_descriptor / mesh_term, loaded by load-mesh.js).
 *
 * This job used to call the NLM API once per string — up to 9 HTTP
 * requests each, three strings at a time. NLM rate-limited it, and
 * because checkCandidate() returned null on both "no match" and "request
 * failed", a 429 was indistinguishable from a miss. The job logged
 * healthy progress while resolving zero strings, every run, for weeks.
 *
 * It was also wrong when it did work: match=contains searched descriptor
 * NAMES only, so "Breast Cancer" resolved to "Breast Cancer Lymphedema"
 * and filed under Blood & Lymphatic.
 *
 * There are now no network calls at all.
 */
async function main() {
  const limit = queueBatchLimit();

  const { data, error } = await db.rpc('classify_pending_conditions', {
    p_limit: null,                      // the whole table; it is one statement
    p_min_similarity: MIN_SIMILARITY,
  });
  if (error) throw new Error(`classify_pending_conditions failed: ${error.message}`);

  const { resolved = 0, still_pending = 0 } = data?.[0] ?? {};
  console.log(
    `classify-conditions: ${resolved} resolved against local MeSH ` +
    `(similarity >= ${MIN_SIMILARITY}), ${still_pending} unmatched.`
  );

  if (!still_pending) {
    console.log('classify-conditions: nothing left for manual classification.');
    return;
  }

  // Whatever MeSH has no concept for — device trials, "Healthy",
  // sponsor-invented phrasings — goes to a human. Bounded per run so a
  // large tail cannot produce an unreviewable commit in one go.
  const unmatched = await fetchAll(
    () => db.from('condition_taxonomy_pending').select('raw_condition'),
    { max: limit }
  );

  const existingRows = await fetchAll(() => db.from('condition_taxonomy').select('category, category_label'));
  const existingCategoryList = [...new Map(existingRows.map((r) => [r.category, r.category_label]))]
    .map(([id, label]) => `- ${id} ("${label}")`)
    .join('\n');

  const entries = unmatched.map(({ raw_condition }) => ({
    id: raw_condition,
    block:
      `## ${raw_condition}\n(no MeSH match)\n\n` +
      `Existing categories — reuse one of these ids if it fits:\n${existingCategoryList || '(none yet)'}\n\n` +
      `CATEGORY:\nCATEGORY_LABEL:\nSUBCATEGORY:\nSUBCATEGORY_LABEL:`,
  }));

  const header =
    '# Pending condition classifications\n\n' +
    'These condition strings had no MeSH match. Fill in CATEGORY / CATEGORY_LABEL / ' +
    'SUBCATEGORY / SUBCATEGORY_LABEL for each (reuse an existing category id where it ' +
    'fits — see the list under each entry). Commit and push when done.';

  // Drop entries that have since been classified, so the file doesn't
  // accumulate stale work.
  const existingQueueContent = readQueue(QUEUE_PATH);
  if (existingQueueContent.trim()) {
    const classified = await fetchAll(() => db.from('condition_taxonomy').select('raw_condition'));
    const cleaned = removeEntries(existingQueueContent, classified.map((r) => r.raw_condition));
    if (cleaned !== existingQueueContent) writeQueue(QUEUE_PATH, cleaned);
  }

  const added = appendNewEntries(QUEUE_PATH, entries, header);
  console.log(`classify-conditions: ${added} string(s) queued for manual classification (limit ${limit}).`);
}

main().catch((err) => {
  console.error('classify-conditions failed:', err);
  process.exit(1);
});
