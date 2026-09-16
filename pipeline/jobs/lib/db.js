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

// Service-role key is required (not the anon key) because jobs write
// directly to tables with no per-row auth policy — this key never
// touches the browser/website, only these server-side jobs.
export const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/**
 * Deterministic hash of the fields that, if changed, should trigger
 * re-extraction and re-summarization. Keeping this narrow (just the
 * clinical content, not e.g. last_synced_at) is what makes the
 * "only regenerate on real change" cost-saving behavior work.
 */
export function criteriaHash({ intervention_raw, inclusion_criteria, exclusion_criteria }) {
  const input = [intervention_raw, inclusion_criteria, exclusion_criteria]
    .map((s) => (s || '').trim())
    .join('\n---\n');
  return crypto.createHash('sha256').update(input).digest('hex');
}
