/**
 * Search engine: modality → providers, parallel run, normalize, dedupe, filters.
 * Provider names never appear in client-facing payloads.
 */

const googleMaps = require('./providers/googleMapsProvider');
const osm = require('./providers/osmProvider');
const apify = require('./providers/apifyProvider');

const MODALITIES = Object.freeze({
  standard: {
    id: 'standard',
    providers: [googleMaps, osm],
  },
  expanded: {
    id: 'expanded',
    providers: [googleMaps, apify],
  },
});

function resolveModality(modality) {
  const key = modality === 'expanded' ? 'expanded' : 'standard';
  return MODALITIES[key];
}

function providersForModality(modality) {
  return resolveModality(modality).providers.map((p) => p.code);
}

function normalizeText(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizePhone(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/\D+/g, '');
}

function dedupeKey(lead) {
  if (lead.externalId && lead.sourceProvider) {
    return `ext:${lead.sourceProvider}:${lead.externalId}`;
  }
  const phone = normalizePhone(lead.phone);
  if (phone && phone.length >= 8) {
    return `phone:${phone}`;
  }
  const name = normalizeText(lead.name);
  const addr = normalizeText(lead.address).slice(0, 48);
  return `na:${name}|${addr}`;
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
      if (Number.isFinite(minR) && (lead.reviewsCount == null || lead.reviewsCount < minR)) {
        return false;
      }
    }
    return true;
  });
}

async function executeSearch(input) {
  const modality = resolveModality(input.modality);
  const criteria = {
    query: String(input.query || '').trim(),
    location: String(input.location || '').trim(),
    filters: input.filters || {},
    limit: input.limit || 100,
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

  const providerResults = await Promise.all(
    modality.providers.map(async (provider) => {
      const result = await provider.search(criteria);
      return { code: provider.code, result };
    })
  );

  const internalProviders = providerResults.map((p) => ({
    code: p.code,
    status: p.result.status,
    count: (p.result.results || []).length,
    errorCode: p.result.errorCode || null,
  }));

  const allRaw = [];
  for (const p of providerResults) {
    if (p.result.results && p.result.results.length) {
      allRaw.push(...p.result.results);
    }
  }

  const afterDedup = deduplicate(allRaw);
  const afterFilters = applyFilters(afterDedup, criteria.filters);

  const statuses = providerResults.map((p) => p.result.status);
  const anyOk = statuses.some((s) => s === 'ok' || s === 'empty');
  const anyResults = afterFilters.length > 0;
  const allFailed = statuses.every((s) => s === 'error' || s === 'not_configured');
  const allEmpty =
    !anyResults && statuses.every((s) => s === 'empty' || s === 'not_configured' || s === 'ok');

  let outcome;
  if (anyResults) {
    outcome = 'results';
  } else if (allFailed) {
    outcome = 'error';
  } else if (allEmpty) {
    outcome = 'no_results';
  } else {
    outcome = anyOk ? 'no_results' : 'error';
  }

  let searchStatus = 'completed';
  if (outcome === 'error') searchStatus = 'failed';
  else if (statuses.some((s) => s === 'error' || s === 'not_configured') && anyResults) {
    searchStatus = 'partial';
  } else if (outcome === 'no_results') searchStatus = 'completed';

  return {
    outcome,
    searchStatus,
    modality: modality.id,
    _providers: internalProviders,
    totals: {
      raw: allRaw.length,
      normalized: allRaw.length,
      afterDedup: afterDedup.length,
      afterFilters: afterFilters.length,
    },
    results: afterFilters,
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
  dedupeKey,
  deduplicate,
  applyFilters,
  executeSearch,
  publicLead,
  clientMessageForOutcome,
};
