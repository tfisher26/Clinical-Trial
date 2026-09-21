import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set these as GitHub Actions secrets ' +
    '(Settings > Secrets and variables > Actions) before running any job.'
  );
}

export const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export function criteriaHash({ intervention_raw, inclusion_criteria, exclusion_criteria }) {
  const input = [intervention_raw, inclusion_criteria, exclusion_criteria]
    .map((s) => (s || '').trim())
    .join('\n---\n');
  return crypto.createHash('sha256').update(input).digest('hex');
}

export async function fetchAll(builderFactory, pageSize = 1000) {
  let allRows = [];
  let from = 0;
  while (true) {
    const { data, error } = await builderFactory().range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return allRows;
}
