import { db } from './lib/db.js';
import { readQueue, writeQueue, parseEntries, removeEntries } from './lib/pendingQueue.js';

/**
 * apply-manual-edits — runs when you push changes to any of the three
 * pending-*/queue.md files. Reads whichever entries you've filled in
 * completely, writes them to the database, then rewrites each file
 * with only the still-unresolved entries left — so the files shrink
 * as you work through them, and nothing you haven't gotten to yet is
 * touched or re-ordered.
 */
async function main() {
  await applySummaries();
  await applyHeadlines();
  await applyQualifyNotes();
  await applyCallouts();
  await applyBasicsExtra();
  await applyCategories();
  await applyRelationships();
}

async function applyHeadlines() {
  const path = 'pending-headlines/queue.md';
  const content = readQueue(path);
  if (!content.trim()) return;

  const entries = parseEntries(content, ['HEADLINE']);
  const done = entries.filter((e) => e.complete);
  if (!done.length) return;

  for (const entry of done) {
    await db.from('trials_curated').upsert(
      { nct_id: entry.id, headline: entry.fields.HEADLINE },
      { onConflict: 'nct_id' }
    );
  }
  writeQueue(path, removeEntries(content, done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${done.length} headline(s).`);
}

async function applyQualifyNotes() {
  const path = 'pending-qualify-notes/queue.md';
  const content = readQueue(path);
  if (!content.trim()) return;

  const entries = parseEntries(content, ['QUALIFY_NOTE']);
  const done = entries.filter((e) => e.complete);
  if (!done.length) return;

  for (const entry of done) {
    await db.from('trials_curated').upsert(
      { nct_id: entry.id, qualify_note: entry.fields.QUALIFY_NOTE },
      { onConflict: 'nct_id' }
    );
  }
  writeQueue(path, removeEntries(content, done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${done.length} qualify note(s).`);
}

async function applyCallouts() {
  const path = 'pending-callouts/queue.md';
  const content = readQueue(path);
  if (!content.trim()) return;

  const entries = parseEntries(content, ['CALLOUT_HEADING', 'CALLOUT_TEXT']);
  const done = entries.filter((e) => e.complete);
  if (!done.length) return;

  for (const entry of done) {
    await db.from('trials_curated').upsert(
      { nct_id: entry.id, extra_callout_heading: entry.fields.CALLOUT_HEADING, extra_callout_text: entry.fields.CALLOUT_TEXT },
      { onConflict: 'nct_id' }
    );
  }
  writeQueue(path, removeEntries(content, done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${done.length} callout(s).`);
}

async function applyBasicsExtra() {
  // Opt-in, freeform — you add entries yourself, format:
  // ## NCT12345678
  // LABEL: How often
  // TEXT: Every two weeks for the first month, then monthly.
  const path = 'pending-basics-extra/queue.md';
  const content = readQueue(path);
  if (!content.trim()) return;

  const entries = parseEntries(content, ['LABEL', 'TEXT']);
  const done = entries.filter((e) => e.complete);
  if (!done.length) return;

  for (const entry of done) {
    const { data: existing } = await db.from('trials_curated').select('basics_extra').eq('nct_id', entry.id).maybeSingle();
    const current = existing?.basics_extra ?? [];
    const updated = [...current, { label: entry.fields.LABEL, text: entry.fields.TEXT }];
    await db.from('trials_curated').upsert(
      { nct_id: entry.id, basics_extra: updated },
      { onConflict: 'nct_id' }
    );
  }
  writeQueue(path, removeEntries(content, done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${done.length} basics_extra entr${done.length === 1 ? 'y' : 'ies'}.`);
}

async function applySummaries() {
  const path = 'pending-summaries/queue.md';
  const content = readQueue(path);
  if (!content.trim()) return;

  const entries = parseEntries(content, ['SUMMARY']);
  const done = entries.filter((e) => e.complete);
  if (!done.length) {
    console.log('apply-manual-edits: no completed summaries yet.');
    return;
  }

  for (const entry of done) {
    const nct_id = entry.id;
    const { data: trial } = await db
      .from('trials_factual')
      .select('criteria_hash')
      .eq('nct_id', nct_id)
      .maybeSingle();
    if (!trial) {
      console.warn(`  ${nct_id}: not found in trials_factual, skipping (may have been removed by a later sync)`);
      continue;
    }

    await db.from('trials_curated').upsert(
      {
        nct_id,
        intervention_summary: entry.fields.SUMMARY,
        source_criteria_hash: trial.criteria_hash,
        model_used: 'manual',
        generated_at: new Date().toISOString(),
      },
      { onConflict: 'nct_id' }
    );
  }

  writeQueue(path, removeEntries(content, done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${done.length} summar${done.length === 1 ? 'y' : 'ies'}.`);
}

async function applyCategories() {
  const path = 'pending-categories/queue.md';
  const content = readQueue(path);
  if (!content.trim()) return;

  const entries = parseEntries(content, ['CATEGORY', 'CATEGORY_LABEL', 'SUBCATEGORY', 'SUBCATEGORY_LABEL']);
  const done = entries.filter((e) => e.complete);
  if (!done.length) {
    console.log('apply-manual-edits: no completed category classifications yet.');
    return;
  }

  for (const entry of done) {
    const raw_condition = entry.id;
    await db.from('condition_taxonomy').upsert({
      raw_condition,
      category: entry.fields.CATEGORY,
      category_label: entry.fields.CATEGORY_LABEL,
      subcategory: entry.fields.SUBCATEGORY,
      subcategory_label: entry.fields.SUBCATEGORY_LABEL,
      classified_by: 'manual',
      classified_at: new Date().toISOString(),
    });
    await db.from('condition_taxonomy_pending').delete().eq('raw_condition', raw_condition);
  }

  writeQueue(path, removeEntries(content, done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${done.length} categor${done.length === 1 ? 'y' : 'ies'}.`);
}

async function applyRelationships() {
  const path = 'pending-relationships/queue.md';
  const content = readQueue(path);
  if (!content.trim()) return;

  const entries = parseEntries(content, ['RELATIONSHIP']);
  const done = entries.filter(
    (e) => e.fields.RELATIONSHIP && ['comorbidity', 'independent'].includes(e.fields.RELATIONSHIP.toLowerCase())
  );
  if (!done.length) {
    console.log('apply-manual-edits: no completed relationship checks yet.');
    return;
  }

  for (const entry of done) {
    const nct_id = entry.id;
    const value = entry.fields.RELATIONSHIP.toLowerCase() === 'comorbidity' ? 'comorbidity' : null;
    await db.from('trials_factual').update({ condition_relationship: value }).eq('nct_id', nct_id);
  }

  writeQueue(path, removeEntries(content, done.map((e) => e.id)));
  console.log(`apply-manual-edits: applied ${done.length} relationship check(s).`);
}

main().catch((err) => {
  console.error('apply-manual-edits failed:', err);
  process.exit(1);
});
