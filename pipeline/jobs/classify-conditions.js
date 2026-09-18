import { db } from './lib/db.js';
import { appendNewEntries, readQueue, writeQueue, removeEntries } from './lib/pendingQueue.js';

const QUEUE_PATH = 'pending-categories/queue.md';

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

  const CONCURRENCY = 3;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const chunk = pending.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async ({ raw_condition }) => {
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
      })
    );
    if ((i / CONCURRENCY) % 20 === 0) console.log(`  classified ${Math.min(i + CONCURRENCY, pending.length)}/${pending.length}...`);
    await new Promise((r) => setTimeout(r, 300));
  }

  const header =
    '# Pending condition classifications\n\n' +
    'These condition strings had no MeSH match. Fill in CATEGORY / CATEGORY_LABEL / ' +
    'SUBCATEGORY / SUBCATEGORY_LABEL for each (reuse an existing category id where it ' +
    'fits — see the list under each entry). Commit and push when done.';

  const existingQueueContent = readQueue(QUEUE_PATH);
  if (existingQueueContent.trim()) {
    const { data: nowClassified } = await db.from('condition_taxonomy').select('raw_condition');
    const classifiedSet = new Set((nowClassified ?? []).map((r) => r.raw_condition));
    const staleIds = [...classifiedSet];
    const cleaned = removeEntries(existingQueueContent, staleIds);
    if (cleaned !== existingQueueContent) writeQueue(QUEUE_PATH, cleaned);
  }

  const added = appendNewEntries(QUEUE_PATH, unresolved, header);

  console.log(`classify-conditions complete: ${meshHits} resolved via free MeSH lookup, ${added} queued for manual classification.`);
}

async function meshLookup(rawCondition, attempt = 1) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const url = new URL(MESH_LOOKUP_URL);
    url.searchParams.set('label', rawCondition);
    url.searchParams.set('match', 'exact');
    url.searchParams.set('limit', '1');

    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) {
        console.warn(`  MeSH lookup rate-limited/failed repeatedly for "${rawCondition}" (status ${res.status}) — queuing for manual review`);
        return null;
      }
      await sleep(2 ** attempt * 1000);
      return meshLookup(rawCondition, attempt + 1);
    }
    if (!res.ok) return null;

    const matches = await res.json();
    if (!matches?.length) return null;

    const descriptorId = matches[0].resource?.split('/').pop();
    if (!descriptorId) return null;

    const detailController = new AbortController();
    const detailTimeoutId = setTimeout(() => detailController.abort(), 15000);
    const detailRes = await fetch(`https://id.nlm.nih.gov/mesh/${descriptorId}.json`, {
      headers: { Accept: 'application/json' },
      signal: detailController.signal,
    });
    clearTimeout(detailTimeoutId);
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
    clearTimeout(timeoutId);
    if (attempt >= 4) {
      console.warn(`  MeSH lookup failed repeatedly for "${rawCondition}": ${err.message} — queuing for manual review`);
      return null;
    }
    await sleep(2 ** attempt * 1000);
    return meshLookup(rawCondition, attempt + 1);
  }
}

function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('classify-conditions failed:', err);
  process.exit(1);
});
