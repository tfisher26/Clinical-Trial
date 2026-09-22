import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared logic for the three manual-review queue files (summaries,
 * categories, relationships). Each file is a plain Markdown list of
 * entries, one per unresolved item, with blank fields for a human to
 * fill in by hand and commit back. The file itself is the source of
 * truth for "still outstanding" — entries are only added if not
 * already present, and removed once resolved and applied.
 */

export function readQueue(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeQueue(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Appends entries whose id isn't already present in the file
 * (matched against the "## <id>" header line). Returns how many were
 * actually added.
 */
export function appendNewEntries(filePath, entries, header) {
  let content = readQueue(filePath);
  if (!content.trim()) content = `${header}\n\n`;

  // Index existing ids ONCE. This used to be a `content.includes(marker)`
  // scan per entry, i.e. O(entries x filesize). At 3k entries over a
  // 3.6MB file that was already ~11 billion character comparisons per
  // run; at the full backlog it does not finish.
  const existing = new Set();
  for (const m of content.matchAll(/^## (.+)$/gm)) existing.add(m[1].trim());

  // Build the whole append in memory and write once, rather than
  // rewriting the file for every entry.
  const additions = [];
  for (const entry of entries) {
    if (existing.has(entry.id)) continue; // already queued, don't duplicate
    existing.add(entry.id);               // guard against dupes within this batch too
    additions.push(entry.block.trim());
  }

  if (additions.length) writeQueue(filePath, content + additions.join('\n\n') + '\n\n');
  return additions.length;
}

/**
 * Splits the file into entry blocks (each starting with "## <id>"),
 * and for each block, extracts FIELD: value lines. Returns
 * { id, fields, block } for every entry found, plus whether it's
 * "complete" per the caller-supplied requiredFields list.
 */
export function parseEntries(content, requiredFields) {
  const blocks = content.split(/\n(?=## )/).filter((b) => b.trim().startsWith('## '));

  return blocks.map((block) => {
    const idMatch = block.match(/^## (.+)$/m);
    const id = idMatch ? idMatch[1].trim() : null;

    const fields = {};
    for (const fieldName of requiredFields) {
      const re = new RegExp(`^${fieldName}:[ \\t]*(.*)$`, 'm');
      const m = block.match(re);
      fields[fieldName] = m ? m[1].trim() : '';
    }

    const complete = requiredFields.every((f) => fields[f] && fields[f].length > 0);
    return { id, block, fields, complete };
  });
}

/**
 * Removes the given entry ids from the file content, leaving
 * everything else (including the header) intact.
 */
export function removeEntries(content, idsToRemove) {
  const idSet = new Set(idsToRemove);
  const blocks = content.split(/\n(?=## )/);
  return blocks
    .filter((block) => {
      const idMatch = block.match(/^## (.+)$/m);
      const id = idMatch ? idMatch[1].trim() : null;
      return !id || !idSet.has(id);
    })
    .join('\n');
}
