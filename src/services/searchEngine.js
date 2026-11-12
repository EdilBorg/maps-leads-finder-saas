/**
 * Search engine: modality → providers, parallel run, normalize, dedupe, filters, global limit.
 * For tests, pass { providers } to executeSearch to inject mocks.
 */

const googleMaps = require('./providers/googleMapsProvider');
const osm = require('./providers/osmProvider');
const apify = require('./providers/apifyProvider');

const MODALITIES = Object.freeze({
  standard: { id: 'standard', providerCodes: ['google_maps', 'osm'] },
  expanded: { id: 'expanded', providerCodes: ['google_maps', 'apify'] },
});

const DEFAULT_PROVIDERS = {
  google_maps: googleMaps,
  osm,
  apify,
};

function resolveModality(modality) {
  return MODALITIES[modality === 'expanded' ? 'expanded' : 'standard'];
}

function providersForModality(modality) {
  return resolveModality(modality).providerCodes.slice();
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

function applyFilters(leads, filters) {
  if (!filters || typeof filters !== 'object') return leads;
  return leads.filter((lead) => {
    if (filters.hasPhone && !lead.phone) return false;
    if (filters.hasEmail && !lead.email) return false;
    if ((filters.noWebsite || filters.hasWebsite === false) && lead.website) return false;
    if (filters.minRating != null && filters.minRating !== '') {
      const min = Number(filters.minRating);
      if (Number.isFinite(min) && (lead.rating == null || lead.rating < min)) return false;
    }
    if (filters.minReviews) {
      const n = Number(lead.reviewsCount);
      if (!Number.isFinite(n) || n < 1) return false;
    }
    return true;
  });
}

function perProviderLimit(globalLimit) {
  return Math.min(Math.max(globalLimit, 20), 200);
}

function normalizeProviderResult(raw) {
  if (raw == null || typeof raw !== 'object') {
    return {
      status: 'error',
      results: [],
      errorCode: 'INVALID_RESPONSE',
      errorMessage: 'Invalid provider response',
      errorStage: null,
      httpStatus: null,
    };
  }
  const allowed = new Set(['ok', 'empty', 'error', 'not_configured']);
  let status = allowed.has(raw.status) ? raw.status : 'error';
  const errorStage = raw.errorStage != null ? String(raw.errorStage) : null;
  const httpStatus =
    raw.httpStatus != null && Number.isFinite(Number(raw.httpStatus))
      ? Number(raw.httpStatus)
      : null;
  if (!Array.isArray(raw.results)) {
    if (status === 'ok' || status === 'empty') {
      return {
        status: 'error',
        results: [],
        errorCode: 'INVALID_RESPONSE',
        errorMessage: 'Provider results must be an array',
        errorStage,
        httpStatus,
      };
    }
    return {
      status,
      results: [],
      errorCode: raw.errorCode || (status === 'error' ? 'PROVIDER_ERROR' : null),
      errorMessage: raw.errorMessage || null,
      errorStage,
      httpStatus,
    };
  }
  const results = raw.results;
  if (status === 'ok' && results.length === 0) status = 'empty';
  return {
    status,
    results,
    errorCode: raw.errorCode || null,
    errorMessage: raw.errorMessage || null,
    errorStage,
    httpStatus,
  };
}

/**
 * Run a single provider in isolation. Never throws.
 */
async function runProviderSafe(providerEntry, criteria) {
  const code = providerEntry && providerEntry.code != null ? providerEntry.code : 'unknown';
  const t0 = Date.now();
  try {
    if (!providerEntry || typeof providerEntry.search !== 'function') {
      return {
        code,
        result: {
          status: 'error',
          results: [],
          errorCode: 'PROVIDER_MISSING',
          errorMessage: 'Provider search unavailable',
          errorStage: null,
          httpStatus: null,
        },
        durationMs: Date.now() - t0,
      };
    }
    const raw = await providerEntry.search(criteria);
    return {
      code,
      result: normalizeProviderResult(raw),
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      code,
      result: {
        status: 'error',
        results: [],
        errorCode: (err && err.code) || 'PROVIDER_ERROR',
        errorMessage: (err && err.message) || 'provider failed',
        errorStage: (err && err.errorStage) || null,
        httpStatus: err && err.httpStatus != null ? err.httpStatus : null,
      },
      durationMs: Date.now() - t0,
    };
  }
}

function isSuccessStatus(status) {
  return status === 'ok' || status === 'empty';
}

function isTechnicalFail(status) {
  return status === 'error';
}

function isUnavailable(status) {
  return status === 'not_configured';
}

function classifySearchOutcome(statuses, hasResults) {
  const list = Array.isArray(statuses) ? statuses : [];
  const anySuccess = list.some(isSuccessStatus);
  const anyTechFail = list.some(isTechnicalFail);
  const anyUnavailable = list.some(isUnavailable);
  const anyCoverageGap = anyTechFail || anyUnavailable;
  const allFailedOrUnavailable = list.length > 0 && list.every((s) => isTechnicalFail(s) || isUnavailable(s));

  if (hasResults) {
    return {
      outcome: 'results',
      searchStatus: anyCoverageGap ? 'partial' : 'completed',
    };
  }

  if (list.length === 0 || allFailedOrUnavailable) {
    return { outcome: 'error', searchStatus: 'failed' };
  }

  if (anySuccess && anyCoverageGap) {
    return { outcome: 'inconclusive', searchStatus: 'partial' };
  }

  if (anySuccess && !anyCoverageGap) {
    return { outcome: 'no_results', searchStatus: 'completed' };
  }

  return { outcome: 'error', searchStatus: 'failed' };
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

  const registry = { ...DEFAULT_PROVIDERS, ...(input.providers || {}) };
  const selected = modality.providerCodes.map((code) => {
    const p = registry[code];
    if (!p || typeof p.search !== 'function') {
      return { code, search: null };
    }
    return { code, search: p.search.bind(p) };
  });

  const started = Date.now();
  const providerResults = await Promise.all(
    selected.map((provider) => runProviderSafe(provider, criteria))
  );

  const internalProviders = providerResults.map((p) => ({
    code: p.code,
    status: p.result.status,
    count: Array.isArray(p.result.results) ? p.result.results.length : 0,
    errorCode: p.result.errorCode || null,
    errorStage: p.result.errorStage || null,
    httpStatus: p.result.httpStatus != null ? p.result.httpStatus : null,
    durationMs: p.durationMs,
  }));

  for (const p of providerResults) {
    if (p.result && p.result.status === 'error') {
      console.info(
        '[provider-error]',
        JSON.stringify({
          provider: p.code,
          stage: p.result.errorStage || null,
          errorCode: p.result.errorCode || null,
          httpStatus: p.result.httpStatus != null ? p.result.httpStatus : null,
          durationMs: p.durationMs,
        })
      );
    }
  }

  const allRaw = [];
  for (const p of providerResults) {
    if (p.result.results && p.result.results.length) allRaw.push(...p.result.results);
  }

  const normalized = allRaw.map(normalizeLead).filter(Boolean);
  const afterDedup = deduplicate(normalized);
  const afterFilters = applyFilters(afterDedup, criteria.filters);
  const limited = afterFilters.slice(0, globalLimit);

  const statuses = providerResults.map((p) => p.result.status);
  const classified = classifySearchOutcome(statuses, limited.length > 0);

  return {
    outcome: classified.outcome,
    searchStatus: classified.searchStatus,
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
  if (outcome === 'no_results') {
    return 'Não foram encontrados estabelecimentos para esta pesquisa. Experimenta alterar a categoria ou a localização.';
  }
  if (outcome === 'inconclusive') {
    return 'Não foi possível concluir a pesquisa em todas as fontes. Os resultados disponíveis podem estar incompletos.';
  }
  return 'Não foi possível realizar a pesquisa neste momento. Tenta novamente mais tarde.';
}

function clientHintForOutcome(outcome) {
  if (outcome === 'no_results') return 'Experimenta alterar a categoria ou a localização.';
  if (outcome === 'inconclusive') return 'Tenta novamente mais tarde ou ajusta os critérios de pesquisa.';
  if (outcome === 'error') return 'Tenta novamente mais tarde.';
  return null;
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
  normalizeProviderResult,
  runProviderSafe,
  classifySearchOutcome,
  executeSearch,
  publicLead,
  clientMessageForOutcome,
  clientHintForOutcome,
};
