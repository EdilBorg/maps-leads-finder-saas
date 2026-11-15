/**
 * Search engine: parallel providers, normalize, dedupe, filters, limits.
 * Providers: apify, tomtom, foursquare only.
 */
const apify = require('./providers/apifyProvider');
const tomtom = require('./providers/tomtomProvider');
const foursquare = require('./providers/foursquareProvider');

const PROVIDER_CODES = Object.freeze(['apify', 'tomtom', 'foursquare']);
const ALLOWED_LIMITS = Object.freeze([100, 200, 300, 400, 500]);
const PROVIDER_MAX = Object.freeze({ apify: 200, tomtom: 200, foursquare: 50 });

function normalizeLimit(value) {
  const n = parseInt(value, 10);
  return ALLOWED_LIMITS.includes(n) ? n : 100;
}

function providerLimit(code, globalLimit) {
  const max = PROVIDER_MAX[code] != null ? PROVIDER_MAX[code] : 100;
  const g = normalizeLimit(globalLimit);
  return Math.min(max, Math.max(g, 1));
}

function normalizeText(s) {
  if (!s || typeof s !== 'string') return '';
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizePhone(s) {
  if (!s || typeof s !== 'string') return '';
  const digits = s.replace(/\D+/g, '');
  return digits.length >= 8 ? digits.slice(-15) : digits;
}

function normalizeWebsite(s) {
  if (!s || typeof s !== 'string') return '';
  try {
    let u = s.trim().toLowerCase();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const parsed = new URL(u);
    let host = parsed.hostname.replace(/^www\./, '');
    let path = parsed.pathname.replace(/\/+$/, '');
    if (path === '/') path = '';
    return host + path;
  } catch (_) {
    return normalizeText(s).replace(/\s+/g, '');
  }
}

function normalizeLead(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const name = lead.name != null ? String(lead.name).trim() : '';
  if (!name) return null;
  let rating = lead.rating;
  if (rating != null) {
    rating = Number(rating);
    if (!Number.isFinite(rating)) rating = null;
  }
  return {
    name,
    address: lead.address != null ? String(lead.address).trim() : null,
    phone: lead.phone != null ? String(lead.phone).trim() : null,
    email: lead.email != null ? String(lead.email).trim() : null,
    website: lead.website != null ? String(lead.website).trim() : null,
    rating,
    reviewsCount: lead.reviewsCount != null ? lead.reviewsCount : lead.reviews_count,
    category: lead.category != null ? String(lead.category).trim() : null,
    lat: lead.lat != null && Number.isFinite(Number(lead.lat)) ? Number(lead.lat) : null,
    lng: lead.lng != null && Number.isFinite(Number(lead.lng)) ? Number(lead.lng) : null,
    photoUrl: lead.photoUrl != null ? String(lead.photoUrl).trim() || null : null,
    googleMapsUrl: lead.googleMapsUrl
      ? String(lead.googleMapsUrl).trim()
      : (lead.raw && lead.raw.googleMapsUrl)
        ? String(lead.raw.googleMapsUrl).trim()
        : (lead.raw && lead.raw.url)
          ? String(lead.raw.url).trim()
          : null,
    sourceProvider: lead.sourceProvider || null,
    externalId: lead.externalId != null ? String(lead.externalId) : null,
    sources: lead.sources || (lead.sourceProvider ? [lead.sourceProvider] : []),
    raw: lead.raw || {},
  };
}

function haversineMeters(a, b) {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return Infinity;
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function mergeLeads(primary, secondary) {
  const pick = (a, b) => (a != null && a !== '' ? a : b);
  const sources = Array.from(new Set([...(primary.sources || [primary.sourceProvider]), ...(secondary.sources || [secondary.sourceProvider])]));
  return {
    name: pick(primary.name, secondary.name),
    address: pick(primary.address, secondary.address),
    phone: pick(primary.phone, secondary.phone),
    email: pick(primary.email, secondary.email),
    website: pick(primary.website, secondary.website),
    rating: primary.rating != null ? primary.rating : secondary.rating,
    reviewsCount: primary.reviewsCount != null ? primary.reviewsCount : secondary.reviewsCount,
    category: pick(primary.category, secondary.category),
    lat: primary.lat != null ? primary.lat : secondary.lat,
    lng: primary.lng != null ? primary.lng : secondary.lng,
    photoUrl: pick(primary.photoUrl, secondary.photoUrl),
    googleMapsUrl: pick(primary.googleMapsUrl, secondary.googleMapsUrl),
    sourceProvider: primary.sourceProvider,
    externalId: primary.externalId || secondary.externalId,
    sources,
    raw: { ...secondary.raw, ...primary.raw, sources },
  };
}

function deduplicate(leads) {
  const out = [];
  const byExt = new Map();
  const byPhone = new Map();
  const byWeb = new Map();
  const byNameAddr = new Map();

  for (const lead of leads) {
    let matched = -1;
    if (lead.externalId && lead.sourceProvider) {
      const ek = 'ext:' + lead.sourceProvider + ':' + lead.externalId;
      if (byExt.has(ek)) matched = byExt.get(ek);
    }
    if (matched < 0) {
      const phone = normalizePhone(lead.phone);
      if (phone && phone.length >= 8 && byPhone.has(phone)) matched = byPhone.get(phone);
    }
    if (matched < 0) {
      const web = normalizeWebsite(lead.website);
      if (web && web.length >= 5 && byWeb.has(web)) matched = byWeb.get(web);
    }
    if (matched < 0) {
      const nName = normalizeText(lead.name);
      const nAddr = normalizeText(lead.address);
      if (nName && nAddr && nAddr.length >= 4) {
        const na = 'na:' + nName + '|' + nAddr.slice(0, 48);
        if (byNameAddr.has(na)) matched = byNameAddr.get(na);
      }
    }
    if (matched < 0 && lead.name && lead.lat != null && lead.lng != null) {
      const nName = normalizeText(lead.name);
      if (nName && (nName.includes(' ') || nName.length >= 8)) {
        for (let i = 0; i < out.length; i++) {
          if (normalizeText(out[i].name) !== nName) continue;
          if (haversineMeters(lead, out[i]) <= 40) { matched = i; break; }
        }
      }
    }
    if (matched >= 0) {
      out[matched] = mergeLeads(out[matched], lead);
      const m = out[matched];
      if (m.externalId && m.sourceProvider) byExt.set('ext:' + m.sourceProvider + ':' + m.externalId, matched);
      const phone = normalizePhone(m.phone);
      if (phone && phone.length >= 8) byPhone.set(phone, matched);
      const web = normalizeWebsite(m.website);
      if (web && web.length >= 5) byWeb.set(web, matched);
      {
        const nName = normalizeText(m.name);
        const nAddr = normalizeText(m.address);
        if (nName && nAddr && nAddr.length >= 4) {
          byNameAddr.set('na:' + nName + '|' + nAddr.slice(0, 48), matched);
        }
      }
      continue;
    }
    const idx = out.length;
    out.push(lead);
    if (lead.externalId && lead.sourceProvider) byExt.set('ext:' + lead.sourceProvider + ':' + lead.externalId, idx);
    const phone = normalizePhone(lead.phone);
    if (phone && phone.length >= 8) byPhone.set(phone, idx);
    const web = normalizeWebsite(lead.website);
    if (web && web.length >= 5) byWeb.set(web, idx);
    {
      const nName = normalizeText(lead.name);
      const nAddr = normalizeText(lead.address);
      if (nName && nAddr && nAddr.length >= 4) {
        byNameAddr.set('na:' + nName + '|' + nAddr.slice(0, 48), idx);
      }
    }
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

/** @deprecated use providerLimit(code, globalLimit) */
function perProviderLimit(globalLimit) {
  return Math.min(Math.max(normalizeLimit(globalLimit), 20), 200);
}

function normalizeProviderResult(raw) {
  if (raw == null || typeof raw !== 'object') {
    return { status: 'error', results: [], errorCode: 'INVALID_RESPONSE', errorMessage: 'invalid', errorStage: null, httpStatus: null };
  }
  let status = raw.status || 'error';
  let results = Array.isArray(raw.results) ? raw.results : null;
  if (status === 'ok' && results && results.length === 0) status = 'empty';
  if (status === 'ok' && results == null) {
    return { status: 'error', results: [], errorCode: 'INVALID_RESPONSE', errorMessage: 'results not array', errorStage: raw.errorStage || null, httpStatus: raw.httpStatus != null ? raw.httpStatus : null };
  }
  if (!Array.isArray(results)) results = [];
  return {
    status,
    results,
    errorCode: raw.errorCode || null,
    errorMessage: raw.errorMessage || null,
    errorStage: raw.errorStage || null,
    httpStatus: raw.httpStatus != null ? raw.httpStatus : null,
  };
}

async function runProviderSafe(provider, criteria, signal) {
  const code = provider && provider.code ? provider.code : 'unknown';
  if (!provider || typeof provider.search !== 'function') {
    return { code, result: { status: 'error', results: [], errorCode: 'PROVIDER_MISSING', errorMessage: 'missing search', errorStage: null, httpStatus: null } };
  }
  try {
    const raw = await provider.search(criteria, signal);
    return { code, result: normalizeProviderResult(raw) };
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || (signal && signal.aborted))) {
      return { code, result: { status: 'error', results: [], errorCode: 'CANCELLED', errorMessage: 'cancelled', errorStage: null, httpStatus: null } };
    }
    return {
      code,
      result: {
        status: 'error',
        results: [],
        errorCode: (err && err.code) || 'PROVIDER_ERROR',
        errorMessage: (err && err.message) || 'error',
        errorStage: null,
        httpStatus: null,
      },
    };
  }
}

function classifySearchOutcome(statuses, hasResults) {
  if (hasResults) {
    const anyError = statuses.some((s) => s === 'error' || s === 'not_configured');
    return { outcome: 'results', searchStatus: anyError ? 'partial' : 'completed' };
  }
  const allEmpty = statuses.length && statuses.every((s) => s === 'empty');
  if (allEmpty) return { outcome: 'no_results', searchStatus: 'completed' };
  const allHardFail = statuses.length && statuses.every((s) => s === 'error' || s === 'not_configured');
  if (allHardFail) return { outcome: 'error', searchStatus: 'failed' };
  return { outcome: 'inconclusive', searchStatus: 'partial' };
}

const DEFAULT_PROVIDERS = {
  apify,
  tomtom,
  foursquare,
};

async function executeSearch(input, opts = {}) {
  const signal = opts.signal;
  const onProviderProgress = typeof opts.onProviderProgress === 'function' ? opts.onProviderProgress : null;
  const globalLimit = normalizeLimit(input.limit);
  const baseCriteria = {
    query: String(input.query || '').trim(),
    location: String(input.location || '').trim(),
    filters: input.filters || {},
  };
  if (!baseCriteria.query) { const err = new Error('Categoria/query obrigatória.'); err.code = 'VALIDATION'; throw err; }
  if (!baseCriteria.location) { const err = new Error('Localização obrigatória.'); err.code = 'VALIDATION'; throw err; }
  if (signal && signal.aborted) {
    return { outcome: 'error', searchStatus: 'cancelled', _providers: [], durationMs: 0,
      totals: { raw: 0, normalized: 0, afterDedup: 0, afterFilters: 0, returned: 0, limit: globalLimit }, results: [], cancelled: true };
  }
  const registry = { ...DEFAULT_PROVIDERS, ...(input.providers || {}) };
  const selected = PROVIDER_CODES.map((code) => {
    const p = registry[code];
    return (!p || typeof p.search !== 'function')
      ? { code, search: null }
      : { code, search: p.search.bind(p) };
  });
  const started = Date.now();

  const providerResults = await Promise.all(
    selected.map(async (p) => {
      if (onProviderProgress) {
        try { onProviderProgress({ code: p.code, status: 'running', count: 0 }); } catch (_) {}
      }
      const criteria = { ...baseCriteria, limit: providerLimit(p.code, globalLimit) };
      const out = await runProviderSafe(p, criteria, signal);
      if (onProviderProgress) {
        try {
          onProviderProgress({
            code: out.code,
            status: out.result.status,
            count: Array.isArray(out.result.results) ? out.result.results.length : 0,
            errorCode: out.result.errorCode || null,
          });
        } catch (_) {}
      }
      return out;
    })
  );

  if (signal && signal.aborted) {
    return { outcome: 'error', searchStatus: 'cancelled',
      _providers: providerResults.map((pr) => ({
        code: pr.code, status: 'cancelled', count: 0, errorCode: 'CANCELLED',
      })),
      durationMs: Date.now() - started,
      totals: { raw: 0, normalized: 0, afterDedup: 0, afterFilters: 0, returned: 0, limit: globalLimit },
      results: [], cancelled: true };
  }

  const allRaw = [];
  const internalProviders = [];
  for (const pr of providerResults) {
    const r = pr.result;
    internalProviders.push({
      code: pr.code,
      status: r.status,
      count: r.results.length,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      errorStage: r.errorStage,
      httpStatus: r.httpStatus,
    });
    for (const item of r.results) allRaw.push(item);
  }

  const normalized = [];
  for (const item of allRaw) {
    const n = normalizeLead(item);
    if (n) normalized.push(n);
  }
  const afterDedup = deduplicate(normalized);
  const afterFilters = applyFilters(afterDedup, baseCriteria.filters);
  const limited = afterFilters.slice(0, globalLimit);
  const statuses = internalProviders.map((p) => p.status);
  const classified = classifySearchOutcome(statuses, limited.length > 0);

  return {
    outcome: classified.outcome, searchStatus: classified.searchStatus, _providers: internalProviders,
    durationMs: Date.now() - started,
    totals: { raw: allRaw.length, normalized: normalized.length, afterDedup: afterDedup.length, afterFilters: afterFilters.length, returned: limited.length, limit: globalLimit },
    results: limited, cancelled: false,
  };
}

function publicLead(lead, index) {
  let googleMapsUrl = lead.googleMapsUrl || null;
  if (!googleMapsUrl && lead.raw && typeof lead.raw === 'object') {
    const candidate = lead.raw.googleMapsUrl || lead.raw.url || null;
    if (candidate && typeof candidate === 'string') googleMapsUrl = candidate;
  }
  return {
    id: lead.id || null, index: index != null ? index : undefined,
    name: lead.name, address: lead.address, phone: lead.phone, email: lead.email, website: lead.website,
    rating: lead.rating, reviewsCount: lead.reviewsCount != null ? lead.reviewsCount : lead.reviews_count,
    category: lead.category, lat: lead.lat, lng: lead.lng, photoUrl: lead.photoUrl || null,
    googleMapsUrl: googleMapsUrl || null,
  };
}

function clientMessageForOutcome(outcome) {
  if (outcome === 'results') return null;
  if (outcome === 'no_results') return 'Não foram encontrados estabelecimentos para esta pesquisa. Experimenta alterar a categoria ou a localização.';
  if (outcome === 'inconclusive') return 'Não foi possível concluir a pesquisa em todas as fontes. Os resultados disponíveis podem estar incompletos.';
  return 'Não foi possível realizar a pesquisa neste momento. Tenta novamente mais tarde.';
}

function clientHintForOutcome(outcome) {
  if (outcome === 'no_results') return 'Experimenta alterar a categoria ou a localização.';
  if (outcome === 'inconclusive') return 'Tenta novamente mais tarde ou ajusta os critérios de pesquisa.';
  if (outcome === 'error') return 'Tenta novamente mais tarde.';
  return null;
}

module.exports = {
  PROVIDER_CODES, PROVIDER_MAX, ALLOWED_LIMITS, normalizeLimit, providerLimit, normalizeText, normalizePhone, normalizeWebsite,
  normalizeLead, deduplicate, mergeLeads, applyFilters, perProviderLimit, normalizeProviderResult,
  runProviderSafe, classifySearchOutcome, executeSearch, publicLead, clientMessageForOutcome, clientHintForOutcome,
  MODALITIES: { standard: { id: 'standard', providerCodes: PROVIDER_CODES } },
  resolveModality: () => ({ id: 'standard', providerCodes: PROVIDER_CODES }),
  providersForModality: () => PROVIDER_CODES.slice(),
  dedupeKey: (lead) => {
    const phone = normalizePhone(lead.phone);
    if (phone && phone.length >= 8) return 'phone:' + phone;
    return 'na:' + normalizeText(lead.name) + '|' + normalizeText(lead.address).slice(0, 48);
  },
};
