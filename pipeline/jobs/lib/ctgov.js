const BASE_URL = 'https://clinicaltrials.gov/api/v2/studies';

const FIELDS = [
  'NCTId', 'OfficialTitle', 'BriefTitle', 'OverallStatus', 'Phase',
  'DesignMasking', 'LeadSponsorName', 'Condition',
  'LocationFacility', 'LocationCity', 'LocationState', 'LocationCountry',
  'MinimumAge', 'MaximumAge', 'Sex',
  'EligibilityCriteria', 'InterventionDescription', 'InterventionName',
  'CentralContactName', 'CentralContactPhone', 'CentralContactEMail',
  'OrgFullName', 'EnrollmentCount', 'StartDate', 'PrimaryCompletionDate',
].join(',');

const PACE_MS = 1200;

/**
 * Pages through /studies with the given query params, yielding each page's
 * raw `studies` array. `stats.totalCount` is set from `countTotal=true`
 * (confirmed working against the live API, 23 Sep 2026).
 */
async function* iterateStudies(params, { pageSize = 1000, stats } = {}) {
  let pageToken = undefined;

  do {
    const url = new URL(BASE_URL);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('countTotal', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const body = await fetchWithRetry(url);
    if (stats && typeof body.totalCount === 'number') stats.totalCount = body.totalCount;

    yield body.studies ?? [];

    pageToken = body.nextPageToken;
    if (pageToken) await sleep(PACE_MS);
  } while (pageToken);
}

/**
 * Every trial (any status) whose record was updated on or after `sinceDate`
 * (YYYY-MM-DD). Filter syntax confirmed against the live API, 23 Sep 2026:
 * AREA[LastUpdatePostDate]RANGE[2026-09-22,MAX] returned 2,151 studies.
 */
export async function* iterateUpdatedSince(sinceDate, opts = {}) {
  const params = {
    'filter.advanced': `AREA[LastUpdatePostDate]RANGE[${sinceDate},MAX]`,
    fields: FIELDS,
  };
  for await (const page of iterateStudies(params, opts)) yield page.map(mapStudy);
}

/**
 * Just the NCT ids of every currently recruiting trial. Used by the weekly
 * reconciliation — no criteria text or locations, so the pages are tiny.
 */
export async function* iterateRecruitingIds(opts = {}) {
  const params = { 'filter.overallStatus': 'RECRUITING', fields: 'NCTId' };
  for await (const page of iterateStudies(params, opts)) {
    yield page.map((s) => s.protocolSection?.identificationModule?.nctId).filter(Boolean);
  }
}

/** Full records for specific trials, fetched in batches of 100 ids. */
export async function fetchTrialsByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const params = { 'filter.ids': ids.slice(i, i + 100).join(','), fields: FIELDS };
    for await (const page of iterateStudies(params)) out.push(...page.map(mapStudy));
  }
  return out;
}

async function fetchWithRetry(url, attempt = 1) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    if (attempt > 5) throw new Error(`ClinicalTrials.gov request timed out/failed after ${attempt} attempts: ${err.message}`);
    console.warn(`  fetch failed/timed out (attempt ${attempt}): ${err.message}, retrying...`);
    await sleep(2 ** attempt * 1000);
    return fetchWithRetry(url, attempt + 1);
  } finally {
    clearTimeout(timeoutId);
  }

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
  if (!ageStr) return null;
  const m = ageStr.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function extractCriteriaSection(fullText, which) {
  if (!fullText) return null;
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

function deriveTags(acronym, conditions, interventions) {
  const interventionNames = interventions.map((i) => i.name).filter(Boolean);
  const raw = [acronym, ...conditions, ...interventionNames].filter(Boolean);
  return [...new Set(raw.map((s) => s.trim()))].join(', ');
}

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
