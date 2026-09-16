import { db } from './lib/db.js';
import { appendNewEntries } from './lib/pendingQueue.js';

const QUEUE_PATH = 'pending-categories/queue.md';

/**
 * classify-conditions — free MeSH lookup only, no AI fallback.
 * Anything MeSH can't resolve gets queued into pending-categories/queue.md
 * for manual classification instead of an AI guess. condition_taxonomy_pending
 * rows are only cleared once resolved via apply-manual-edits.js (or a
 * successful MeSH match) — the DB and the file agree on what's still open.
 *
 * TREE_BRANCH_TO_CATEGORY covers all 26 top-level MeSH disease branches
 * (C01-C26) plus F03 (Mental Disorders) — most conditions should resolve
 * here for free. The queue should stay small in practice.
 */
const MESH_LOOKUP_URL = 'https://id.nlm.nih.gov/mesh/lookup/term';

const TREE_BRANCH_TO_CATEGORY = {
  C01: { category: 'infectious', category_label: 'Infectious Disease' },
  C02: { category: 'infectious', category_label: 'Infectious Disease' },
  C03: { category: 'infectious', category_label: 'Infectious Disease' },
  C04: { category: 'cancer', category_label: 'Cancer' },
  C05: { category: 'musculoskeletal', category_label: 'Musculoskeletal' },
  C06: { category: 'digestive', category_label: 'Digestive & GI' },
  C07: { category: 'other', category_label: 'Other Conditions' },
  C08: { category: 'respiratory', category_label: 'Respiratory' },
  C09: { category: 'ent', category_label: 'Ear, Nose & Throat' },
  C10: { category: 'neurological', category_label: 'Neurological' },
  C11: { category: 'eye', category_label: 'Eye & Vision' },
  C12: { category: 'renal', category_label: 'Kidney & Urologic' },
  C13: { category: 'womens_health', category_label: "Women's Health" },
  C14: { category: 'cardiovascular', category_label: 'Heart & Cardiovascular' },
  C15: { category: 'blood', category_label: 'Blood & Lymphatic' },
  C16: { category: 'genetic', category_label: 'Genetic & Congenital' },
  C17: { category: 'skin', category_label: 'Skin & Connective Tissue' },
  C18: { category: 'metabolic', category_label: 'Metabolic & Weight' },
  C19: { category: 'metabolic', category_label: 'Metabolic & Weight' },
  C20: { category: 'immune', category_label: 'Immune System & Autoimmune' },
  C21: { category: 'other', category_label: 'Other Conditions' },
  C23: { category: 'other', category_label: 'Other Conditions' },
  C24: { category: 'other', category_label: 'Other Conditions' },
  C25: { category: 'other', category_label: 'Other Conditions' },
  C26: { category: 'other', category_label: 'Other Conditions' },
  F03: { category: 'mental_health', category_label: 'Mental Health' },
};

async function main() {
  const { data: pending } = await db.from('condition_taxonomy_pending').select('raw_condition');
  if (!pending?.length) {
    console.log('classify-conditions: nothing pending.');
    return;
  }

  console.log(`classify-conditions: ${pending.length} new condition strings to check.`);

  const { data: existingRows } = await db.from('condition_taxonomy').select('category, category_label');
  const existingCategoryList = [...new Map((existingRows ?? []).map((r) => [r.category, r.category_label]))]
    .map(([id, label]) => `- ${id} ("${label}")`)
    .join('\n');

  let meshHits = 0;
  const unresolved = [];

  for (const { raw_condition } of pending) {
    const meshResult = await meshLookup(raw_condition);

    if (meshResult) {
      meshHits++;
      await db.from('condition_taxonomy').upsert({
        raw_condition,
        ...meshResult,
        classified_by: 'mesh_mapping',
        classified_at: new Date().toISOString(),
      });
      await db.from('condition_taxonomy_pending').delete().eq('raw_condition', raw_condition);
    } else {
      unresolved.push({
        id: raw_condition,
        block:
          `## ${raw_condition}\n(no MeSH match found)\n\n` +
          `Existing categories — reuse one of these ids if it fits:\n${existingCategoryList || '(none yet)'}\n\n` +
          `CATEGORY:\nCATEGORY_LABEL:\nSUBCATEGORY:\nSUBCATEGORY_LABEL:`,
      });
    }
  }

  const header =
    '# Pending condition classifications\n\n' +
    'These condition strings had no MeSH match. Fill in CATEGORY / CATEGORY_LABEL / ' +
    'SUBCATEGORY / SUBCATEGORY_LABEL for each (reuse an existing category id where it ' +
    'fits — see the list under each entry). Commit and push when done.';
  const added = appendNewEntries(QUEUE_PATH, unresolved, header);

  console.log(`classify-conditions complete: ${meshHits} resolved via free MeSH lookup, ${added} queued for manual classification.`);
}

async function meshLookup(rawCondition) {
  try {
    const url = new URL(MESH_LOOKUP_URL);
    url.searchParams.set('label', rawCondition);
    url.searchParams.set('match', 'exact');
    url.searchParams.set('limit', '1');

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const matches = await res.json();
    if (!matches?.length) return null;

    const descriptorId = matches[0].resource?.split('/').pop();
    if (!descriptorId) return null;

    const detailRes = await fetch(`https://id.nlm.nih.gov/mesh/${descriptorId}.json`, {
      headers: { Accept: 'application/json' },
    });
    if (!detailRes.ok) return null;
    const detail = await detailRes.json();

    const treeNumbers = (detail.treeNumber || []).map((t) => (typeof t === 'string' ? t : t['@id']?.split('/').pop()));
    for (const tree of treeNumbers) {
      const branch = tree?.split('.')[0];
      if (branch && TREE_BRANCH_TO_CATEGORY[branch]) {
        const cat = TREE_BRANCH_TO_CATEGORY[branch];
        const label = matches[0].label || rawCondition;
        return {
          category: cat.category,
          category_label: cat.category_label,
          subcategory: slugify(label),
          subcategory_label: label,
        };
      }
    }
    return null;
  } catch (err) {
    console.warn(`  MeSH lookup failed for "${rawCondition}": ${err.message} — queuing for manual review`);
    return null;
  }
}

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

main().catch((err) => {
  console.error('classify-conditions failed:', err);
  process.exit(1);
});
