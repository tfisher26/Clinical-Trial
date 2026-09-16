const BASE_URL = 'https://clinicaltrials.gov/api/v2/studies';

// Only the fields we actually store — requesting a narrower field set
// keeps each page smaller and the sync faster.
const FIELDS = [
  'NCTId', 'OfficialTitle', 'BriefTitle', 'OverallStatus', 'Phase',
  'DesignMasking', 'LeadSponsorName', 'Condition',
  'LocationFacility', 'LocationCity', 'LocationState', 'LocationCountry',
  'MinimumAge', 'MaximumAge', 'Sex',
  'EligibilityCriteria', 'InterventionDescription', 'InterventionName',
  'CentralContactName', 'CentralContactPhone', 'CentralContactEMail',
  'OrgFullName', 'EnrollmentCount', 'StartDate', 'PrimaryCompletionDate',
].join(',');

/**
 * Walks the full set of recruiting trials via cursor-based pagination.
 *
 * Verified against ClinicalTrials.gov API v2 docs and independent
 * confirmation (Sept 2026): pageSize max is 1000 (default 10, so it
 * must be set explicitly), pagination uses nextPageToken (not a
 * numeric offset — jumping to page N isn't supported), and the
 * endpoint requires no API key or auth. There is no single official
 * published hard rate limit; community guidance converges on staying
 * near ~50 requests/minute and handling 429s with backoff, which is
 * what PACE_MS and the retry below implement. Re-check
 * https://clinicaltrials.gov/data-api/api before depending on these
 * numbers at larger scale — the API has changed shape before.
 */
const PACE_MS = 1200; // ~50 req/min, conservative given no published hard limit

export async function* iterateRecruitingTrials({ pageSize = 1000 } = {}) {
  let pageToken = undefined;

  do {
    const url = new URL(BASE_URL);
    url.searchParams.set('filter.overallStatus', 'RECRUITING');
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const body = await fetchWithRetry(url);

    for (const study of body.studies ?? []) {
      yield mapStudy(study);
    }

    pageToken = body.nextPageToken;
    if (pageToken) await sleep(PACE_MS);
  } while (pageToken);
}

async function fetchWithRetry(url, attempt = 1) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 5) throw new Error(`ClinicalTrials.gov API error ${res.status} after ${attempt} attempts`);
    const backoff = 2 ** attempt * 1000;
    console.warn(`  ClinicalTrials.gov returned ${res.status}, retrying in ${backoff}ms (attempt ${attempt})`);
    await sleep(backoff);
    return fetchWithRetry(url, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`ClinicalTrials.gov API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapStudy(study) {
  const s = study.protocolSection ?? {};
  const id = s.identificationModule ?? {};
  const status = s.statusModule ?? {};
  const design = s.designModule ?? {};
  const sponsor = s.sponsorCollaboratorsModule?.leadSponsor ?? {};
  const conditions = s.conditionsModule?.conditions ?? [];
  const locations = s.contactsLocationsModule?.locations ?? [];
  const centralContacts = s.contactsLocationsModule?.centralContacts ?? [];
  const eligibility = s.eligibilityModule ?? {};
  const interventions = s.armsInterventionsModule?.interventions ?? [];

  return {
    nct_id: id.nctId,
    official_name: id.officialTitle || id.briefTitle,
    also_known_as: id.acronym || null,
    status: status.overallStatus,
    phase: (design.phases || [])[0] || null,
    masking: design.designInfo?.maskingInfo?.masking || null,
    sponsor: sponsor.name || null,
    raw_conditions: conditions,
    age_min: parseAge(eligibility.minimumAge),
    age_max: parseAge(eligibility.maximumAge),
    sex: eligibility.sex || null,
    inclusion_criteria: extractCriteriaSection(eligibility.eligibilityCriteria, 'inclusion'),
    exclusion_criteria: extractCriteriaSection(eligibility.eligibilityCriteria, 'exclusion'),
    intervention_raw: interventions.map((i) => `${i.type ?? ''}: ${i.name ?? ''}${i.description ? ' — ' + i.description : ''}`).join('\n'),
    tags: deriveTags(id.acronym, conditions, interventions),
    enrollment_count: s.designModule?.enrollmentInfo?.count ?? null,
    duration_text: deriveDuration(status.startDateStruct?.date, status.primaryCompletionDateStruct?.date),
    locations: {
      group_label: locations.length ? `${locations.length} site${locations.length === 1 ? '' : 's'}` : null,
      sites: locations.slice(0, 20).map((l) => [l.facility, l.city, l.state, l.country].filter(Boolean).join(', ')),
      note: locations.length > 20 ? `${locations.length} locations total — check the official listing for the full list.` : null,
      contact: centralContacts[0]
        ? [centralContacts[0].name, centralContacts[0].phone, centralContacts[0].email].filter(Boolean).join(' — ')
        : null,
    },
    site_scope: summarizeSiteScope(locations),
    official_link: `https://clinicaltrials.gov/study/${id.nctId}`,
  };
}

function parseAge(ageStr) {
  // CT.gov returns e.g. "18 Years" — pull the leading integer.
  if (!ageStr) return null;
  const m = ageStr.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function extractCriteriaSection(fullText, which) {
  if (!fullText) return null;
  // CT.gov's eligibilityCriteria is one free-text blob with
  // "Inclusion Criteria:" / "Exclusion Criteria:" headers. This is a
  // best-effort split on those headers — deliberately NOT an AI call,
  // this is deterministic string splitting only.
  const incMatch = fullText.match(/Inclusion Criteria:?([\s\S]*?)(Exclusion Criteria:|$)/i);
  const excMatch = fullText.match(/Exclusion Criteria:?([\s\S]*)$/i);
  if (which === 'inclusion') return incMatch ? incMatch[1].trim() : fullText.trim();
  return excMatch ? excMatch[1].trim() : null;
}

function summarizeSiteScope(locations) {
  if (!locations.length) return null;
  const countries = [...new Set(locations.map((l) => l.country).filter(Boolean))];
  const countryPart = countries.length > 2 ? `${countries.length} countries` : countries.join(', ');
  return `${locations.length} site${locations.length === 1 ? '' : 's'}${countryPart ? ' · ' + countryPart : ''}`;
}

/**
 * Deterministic, no-AI search-keyword derivation — just concatenates
 * fields already pulled from CT.gov (trial nickname + condition names +
 * intervention/drug names) so a visitor searching a drug name or an
 * acronym like "TRIUMPH-9" can find the trial, not just official
 * condition terminology. Deduped, comma-separated.
 */
function deriveTags(acronym, conditions, interventions) {
  const interventionNames = interventions.map((i) => i.name).filter(Boolean);
  const raw = [acronym, ...conditions, ...interventionNames].filter(Boolean);
  return [...new Set(raw.map((s) => s.trim()))].join(', ');
}

/**
 * Rough plain-language duration from start/primary-completion dates —
 * deterministic date math, no AI. CT.gov dates are sometimes
 * month-only ("2025-03"), so this is intentionally approximate
 * ("about X weeks/months/years"), matching how the original
 * hand-authored trials.json phrased it.
 */
function deriveDuration(startDate, completionDate) {
  if (!startDate || !completionDate) return null;
  const start = new Date(startDate.length === 7 ? startDate + '-01' : startDate);
  const end = new Date(completionDate.length === 7 ? completionDate + '-01' : completionDate);
  if (isNaN(start) || isNaN(end) || end <= start) return null;

  const days = Math.round((end - start) / (1000 * 60 * 60 * 24));
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `about ${weeks} weeks`;
  if (weeks < 104) return `about ${Math.round(weeks / 4.345)} months`;
  const years = Math.round((weeks / 52) * 10) / 10;
  return `about ${years} years`;
}
