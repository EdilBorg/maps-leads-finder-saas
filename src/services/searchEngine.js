/**
 * Search engine: Apify + TomTom + Foursquare in parallel.
 * Per-provider limits: Apify 200, TomTom 200, Foursquare 50.
 * Smart dedupe, filters, global limit, AbortSignal support.
 */
const apify = require('./providers/apifyProvider');
const tomtom = require('./providers/tomtomProvider');
const foursquare = require('./providers/foursquareProvider');

const PROVIDER_CODES = Object.freeze(['apify', 'tomtom', 'foursquare']);
const DEFAULT_PROVIDERS = { apify, tomtom, foursquare };
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
  return {
    name: lead.name != null ? String(lead.name).trim() || null : null,
    address: lead.address != null ? String(lead.address).trim() || null : null,
    phone: lead.phone != null ? String(lead.phone).trim() || null : null,
    email: lead.email != null ? String(lead.email).trim() || null : null,
    website: lead.website != null ? String(lead.website).trim() || null : null,
    rating: typeof lead.rating === 'number' && Number.isFinite(lead.rating) ? lead.rating : null,
    reviewsCount: typeof lead.reviewsCount === 'number' && Number.isFinite(lead.reviewsCount)
      ? lead.reviewsCount
      : typeof lead.reviews_count === 'number' ? lead.reviews_count : null,
    category: lead.category != null ? String(lead.category).trim() || null : null,
    lat: lead.lat != null && Number.isFinite(Number(lead.lat)) ? Number(lead.lat) : null,
    lng: lead.lng != null && Number.isFinite(Number(lead.lng)) ? Number(lead.lng) : null,
    photoUrl: lead.photoUrl != null ? String(lead.photoUrl).trim() || null : null,
    sourceProvider: lead.sourceProvider || 'unknown',
    externalId: lead.externalId != null ? String(lead.externalId) : null,
    sources: lead.sources || [lead.sourceProvider || 'unknown'],
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
    return { status: 'error', results: [], errorCode: 'INVALID_RESPONSE', errorMessage: 'Invalid provider response' };
  }
  const allowed = new Set(['ok', 'empty', 'error', 'not_configured']);
  let status = allowed.has(raw.status) ? raw.status : 'error';
  if (!Array.isArray(raw.results)) {
    return {
      status: 'error',
      results: [],
      errorCode: 'INVALID_RESPONSE',
      errorMessage: 'Provider results must be an array',
      errorStage: raw.errorStage || null,
      httpStatus: raw.httpStatus != null ? raw.httpStatus : null,
    };
  }
  if (status === 'ok' && raw.results.length === 0) status = 'empty';
  return {
    status,
    results: raw.results,
    errorCode: raw.errorCode || null,
    errorMessage: raw.errorMessage || null,
    errorStage: raw.errorStage || null,
    httpStatus: raw.httpStatus != null ? raw.httpStatus : null,
  };
}

async function runProviderSafe(providerEntry, criteria, signal) {
  const code = providerEntry && providerEntry.code != null ? providerEntry.code : 'unknown';
  const t0 = Date.now();
  try {
    if (signal && signal.aborted) {
      return { code, result: { status: 'error', results: [], errorCode: 'CANCELLED', errorMessage: 'cancelled' }, durationMs: 0 };
    }
    if (!providerEntry || typeof providerEntry.search !== 'function') {
      return { code, result: { status: 'error', results: [], errorCode: 'PROVIDER_MISSING', errorMessage: 'Provider search unavailable' }, durationMs: Date.now() - t0 };
    }
    const raw = await providerEntry.search(criteria, { signal });
    return { code, result: normalizeProviderResult(raw), durationMs: Date.now() - t0 };
  } catch (err) {
    return {
      code,
      result: { status: 'error', results: [], errorCode: (err && err.code) || 'PROVIDER_ERROR', errorMessage: (err && err.message) || 'provider failed' },
      durationMs: Date.now() - t0,
    };
  }
}

function isSuccessStatus(status) { return status === 'ok' || status === 'empty'; }
function isTechnicalFail(status) { return status === 'error'; }
function isUnavailable(status) { return status === 'not_configured'; }

function classifySearchOutcome(statuses, hasResults) {
  const list = Array.isArray(statuses) ? statuses : [];
  const anySuccess = list.some(isSuccessStatus);
  const anyTechFail = list.some(isTechnicalFail);
  const anyUnavailable = list.some(isUnavailable);
  const anyCoverageGap = anyTechFail || anyUnavailable;
  const allFailed = list.length > 0 && list.every((s) => isTechnicalFail(s) || isUnavailable(s));
  if (hasResults) return { outcome: 'results', searchStatus: anyCoverageGap ? 'partial' : 'completed' };
  if (list.length === 0 || allFailed) return { outcome: 'error', searchStatus: 'failed' };
  if (anySuccess && anyCoverageGap) return { outcome: 'inconclusive', searchStatus: 'partial' };
  if (anySuccess && !anyCoverageGap) return { outcome: 'no_results', searchStatus: 'completed' };
  return { outcome: 'error', searchStatus: 'failed' };
}

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
      _providers: providerResults.map((p) => ({ code: p.code, status: 'error', count: 0, errorCode: 'CANCELLED', durationMs: p.durationMs })),
      durationMs: Date.now() - started,
      totals: { raw: 0, normalized: 0, afterDedup: 0, afterFilters: 0, returned: 0, limit: globalLimit }, results: [], cancelled: true };
  }
  const internalProviders = providerResults.map((p) => ({
    code: p.code,
    status: p.result.status,
    count: Array.isArray(p.result.results) ? p.result.results.length : 0,
    errorCode: p.result.errorCode || null,
    errorStage: p.result.errorStage || null,
    httpStatus: p.result.httpStatus != null ? p.result.httpStatus : null,
    durationMs: p.durationMs,
  }));
  const allRaw = [];
  for (const p of providerResults) {
    if (p.result.results && p.result.results.length) allRaw.push(...p.result.results);
  }
  const normalized = allRaw.map(normalizeLead).filter(Boolean);
  const afterDedup = deduplicate(normalized);
  const afterFilters = applyFilters(afterDedup, baseCriteria.filters);
  const limited = afterFilters.slice(0, globalLimit);
  const classified = classifySearchOutcome(providerResults.map((p) => p.result.status), limited.length > 0);
  return {
    outcome: classified.outcome, searchStatus: classified.searchStatus, _providers: internalProviders,
    durationMs: Date.now() - started,
    totals: { raw: allRaw.length, normalized: normalized.length, afterDedup: afterDedup.length, afterFilters: afterFilters.length, returned: limited.length, limit: globalLimit },
    results: limited, cancelled: false,
  };
}

function publicLead(lead, index) {
  return {
    id: lead.id || null, index: index != null ? index : undefined,
    name: lead.name, address: lead.address, phone: lead.phone, email: lead.email, website: lead.website,
    rating: lead.rating, reviewsCount: lead.reviewsCount != null ? lead.reviewsCount : lead.reviews_count,
    category: lead.category, lat: lead.lat, lng: lead.lng, photoUrl: lead.photoUrl || null,
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
