/**
 * Search engine: modality → providers, parallel run, normalize, dedupe, filters, global limit.
 */
const googleMaps = require('./providers/googleMapsProvider');
const osm = require('./providers/osmProvider');
const apify = require('./providers/apifyProvider');

const MODALITIES = Object.freeze({
  standard: { id: 'standard', providers: [googleMaps, osm] },
  expanded: { id: 'expanded', providers: [googleMaps, apify] },
});

function resolveModality(modality) {
  return MODALITIES[modality === 'expanded' ? 'expanded' : 'standard'];
}

function providersForModality(modality) {
  return resolveModality(modality).providers.map((p) => p.code);
}

function normalizeText(s) {
  if (!s || typeof s !== 'string') return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizePhone(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/\D+/g, '');
}

function normalizeLead(lead) {
  if (!lead || typeof lead !== 'object') return null;
  return {
    name: lead.name != null ? String(lead.name).trim() || null : null,
    address: lead.address != null ? String(lead.address).trim() || null : null,
    phone: lead.phone != null ? String(lead.phone).trim() || null : null,
    email: lead.email != null ? String(lead.email).trim() || null : null,
    website: lead.website != null ? String(lead.website).trim() || null : null,
    rating: typeof lead.rating === 'number' && Number.isFinite(lead.rating) ? lead.rating : null,
    reviewsCount:
      typeof lead.reviewsCount === 'number' && Number.isFinite(lead.reviewsCount)
        ? lead.reviewsCount
        : typeof lead.reviews_count === 'number'
          ? lead.reviews_count
          : null,
    category: lead.category != null ? String(lead.category).trim() || null : null,
    lat: lead.lat != null && Number.isFinite(Number(lead.lat)) ? Number(lead.lat) : null,
    lng: lead.lng != null && Number.isFinite(Number(lead.lng)) ? Number(lead.lng) : null,
    sourceProvider: lead.sourceProvider || 'unknown',
    externalId: lead.externalId != null ? String(lead.externalId) : null,
    raw: lead.raw || {},
  };
}

function dedupeKey(lead) {
  if (lead.externalId && lead.sourceProvider) return `ext:${lead.sourceProvider}:${lead.externalId}`;
  const phone = normalizePhone(lead.phone);
  if (phone && phone.length >= 8) return `phone:${phone}`;
  return `na:${normalizeText(lead.name)}|${normalizeText(lead.address).slice(0, 48)}`;
}

function deduplicate(leads) {
  const seen = new Map();
  const out = [];
  for (const lead of leads) {
    const key = dedupeKey(lead);
    if (seen.has(key)) continue;
    seen.set(key, true);
    out.push(lead);
  }
  return out;
}

function applyFilters(leads, filters = {}) {
  return leads.filter((lead) => {
    if (filters.hasPhone && !lead.phone) return false;
    if (filters.hasEmail && !lead.email) return false;
    if (filters.noWebsite && lead.website) return false;
    if (filters.minRating != null && filters.minRating !== '') {
      const min = Number(filters.minRating);
      if (Number.isFinite(min) && (lead.rating == null || lead.rating < min)) return false;
    }
    if (filters.minReviews != null && filters.minReviews !== '' && filters.minReviews !== false) {
      const minR = Number(filters.minReviews);
      if (Number.isFinite(minR) && minR > 0 && (lead.reviewsCount == null || lead.reviewsCount < minR)) return false;
    }
    return true;
  });
}

function perProviderLimit(globalLimit) {
  return Math.min(Math.max(globalLimit, 20), 200);
}

async function executeSearch(input) {
  const modality = resolveModality(input.modality);
  const globalLimit = Math.min(Math.max(parseInt(input.limit, 10) || 100, 1), 500);
  const criteria = {
    query: String(input.query || '').trim(),
    location: String(input.location || '').trim(),
    filters: input.filters || {},
    limit: perProviderLimit(globalLimit),
  };
  if (!criteria.query) {
    const err = new Error('Categoria/query obrigatória.');
    err.code = 'VALIDATION';
    throw err;
  }
  if (!criteria.location) {
    const err = new Error('Localização obrigatória.');
    err.code = 'VALIDATION';
    throw err;
  }

  const started = Date.now();
  const providerResults = await Promise.all(
    modality.providers.map(async (provider) => {
      const t0 = Date.now();
      const result = await provider.search(criteria);
      return { code: provider.code, result, durationMs: Date.now() - t0 };
    })
  );

  const internalProviders = providerResults.map((p) => ({
    code: p.code,
    status: p.result.status,
    count: (p.result.results || []).length,
    errorCode: p.result.errorCode || null,
    durationMs: p.durationMs,
  }));

  const allRaw = [];
  for (const p of providerResults) {
    if (p.result.results && p.result.results.length) allRaw.push(...p.result.results);
  }

  const normalized = allRaw.map(normalizeLead).filter(Boolean);
  const afterDedup = deduplicate(normalized);
  const afterFilters = applyFilters(afterDedup, criteria.filters);
  const limited = afterFilters.slice(0, globalLimit);

  const statuses = providerResults.map((p) => p.result.status);
  const anyResults = limited.length > 0;
  const hardFail = (s) => s === 'error' || s === 'not_configured';
  const softEmpty = (s) => s === 'empty' || s === 'ok';
  const allHardFailed = statuses.every(hardFail);
  const allEmptyOrOk = statuses.every((s) => softEmpty(s) || s === 'not_configured');

  let outcome;
  if (anyResults) outcome = 'results';
  else if (allHardFailed) outcome = 'error';
  else if (statuses.some(hardFail) && statuses.some((s) => s === 'empty' || s === 'ok')) outcome = 'no_results';
  else if (allEmptyOrOk) outcome = 'no_results';
  else outcome = 'error';

  let searchStatus = 'completed';
  if (outcome === 'error') searchStatus = 'failed';
  else if (anyResults && statuses.some(hardFail)) searchStatus = 'partial';

  return {
    outcome,
    searchStatus,
    modality: modality.id,
    _providers: internalProviders,
    durationMs: Date.now() - started,
    totals: {
      raw: allRaw.length,
      normalized: normalized.length,
      afterDedup: afterDedup.length,
      afterFilters: afterFilters.length,
      returned: limited.length,
      limit: globalLimit,
    },
    results: limited,
  };
}

function publicLead(lead, index) {
  return {
    id: lead.id || null,
    index: index != null ? index : undefined,
    name: lead.name,
    address: lead.address,
    phone: lead.phone,
    email: lead.email,
    website: lead.website,
    rating: lead.rating,
    reviewsCount: lead.reviewsCount != null ? lead.reviewsCount : lead.reviews_count,
    category: lead.category,
    lat: lead.lat,
    lng: lead.lng,
  };
}

function clientMessageForOutcome(outcome) {
  if (outcome === 'results') return null;
  if (outcome === 'no_results') return 'Nenhum resultado encontrado.';
  return 'Não foi possível realizar a pesquisa. Ocorreu um problema. Tenta novamente.';
}

module.exports = {
  MODALITIES,
  resolveModality,
  providersForModality,
  normalizeText,
  normalizePhone,
  normalizeLead,
  dedupeKey,
  deduplicate,
  applyFilters,
  perProviderLimit,
  executeSearch,
  publicLead,
  clientMessageForOutcome,
};
