/**
 * Search engine: sequential providers (DataForSEO primary → TomTom Discover complementary).
 * Apify / Bright Data remain on disk for historical recovery only — not used for new searches.
 */
const dataforseo = require('./providers/dataForSeoProvider');
const tomtom = require('./providers/tomtomProvider');
// Historical providers kept available for recovery/reconciler only
const apify = require('./providers/apifyProvider');
const brightdata = require('./providers/brightDataProvider');

/** Active providers for new searches (order matters: primary first). */
const PROVIDER_CODES = Object.freeze(['dataforseo', 'tomtom']);
/** All known codes including historical (diagnostics / recovery). */
const ALL_PROVIDER_CODES = Object.freeze(['dataforseo', 'tomtom', 'apify', 'brightdata']);
const ALLOWED_LIMITS = Object.freeze([100, 200, 300, 400, 500]);
/** Per-provider contribution cap for active path. */
const PROVIDER_MAX = Object.freeze({ dataforseo: 500, tomtom: 100, apify: 500, brightdata: 200 });

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

/** Centralized URL classification for the "Sem website" filter.
 * Categories: own_website | social_media | directory | unknown | none
 * Classification is by domain (and path only for specific cases like Google Maps).
 * Limitation: without external checks we cannot confirm domain ownership;
 * unrecognized valid hosts are therefore unknown, not own_website.
 * own_website remains reserved for future explicit recognition policies.
 */
const SOCIAL_MEDIA_DOMAINS = Object.freeze([
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'x.com',
  'twitter.com',
  'pinterest.com',
  'threads.net',
  'snapchat.com',
]);

const DIRECTORY_DOMAINS = Object.freeze([
  'yelp.com',
  'tripadvisor.com',
  'yellowpages.com',
  'foursquare.com',
]);

function hostMatchesDomain(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith('.' + domain);
}

function classifyWebsiteUrl(url) {
  if (url == null) return 'none';
  if (typeof url !== 'string') return 'unknown';
  const raw = url.trim();
  if (!raw) return 'none';

  let parsed;
  try {
    let candidate = raw;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
      candidate = 'https://' + candidate;
    }
    parsed = new URL(candidate);
  } catch (_) {
    return 'unknown';
  }

  const protocol = (parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return 'unknown';
  }

  let host = (parsed.hostname || '').toLowerCase();
  if (!host) return 'unknown';
  if (host.startsWith('www.')) host = host.slice(4);

  for (const domain of SOCIAL_MEDIA_DOMAINS) {
    if (hostMatchesDomain(host, domain)) return 'social_media';
  }

  for (const domain of DIRECTORY_DOMAINS) {
    if (hostMatchesDomain(host, domain)) return 'directory';
  }

  // Google Maps: only maps paths, never the whole google.com domain
  if (host === 'google.com' || host.endsWith('.google.com')) {
    const path = (parsed.pathname || '').toLowerCase();
    if (path.startsWith('/maps') || host === 'maps.google.com' || host.startsWith('maps.')) {
      return 'directory';
    }
    // other google services → unknown (exclude on noWebsite for safety)
    return 'unknown';
  }

  // Valid host not in social/directory lists: we cannot confirm ownership
  // without external checks, so treat as unknown (not own_website).
  // own_website remains reserved for future explicit recognition policies.
  return 'unknown';
}

/** Priority for merge: lower rank = higher preference. Deterministic and order-independent. */
const WEBSITE_CATEGORY_RANK = Object.freeze({
  own_website: 1,
  social_media: 2,
  directory: 3,
  unknown: 4,
  none: 5,
});

function pickPreferredWebsite(a, b) {
  const ca = classifyWebsiteUrl(a);
  const cb = classifyWebsiteUrl(b);
  const ra = WEBSITE_CATEGORY_RANK[ca] != null ? WEBSITE_CATEGORY_RANK[ca] : 5;
  const rb = WEBSITE_CATEGORY_RANK[cb] != null ? WEBSITE_CATEGORY_RANK[cb] : 5;

  if (ra < rb) return a;
  if (rb < ra) return b;

  // Same category: deterministic tie-break independent of argument order.
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  if (!sa && !sb) return a;
  if (!sa) return b;
  if (!sb) return a;
  if (sa === sb) return a;
  return sa < sb ? a : b;
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
    website: pickPreferredWebsite(primary.website, secondary.website),
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
    if (filters.noWebsite || filters.hasWebsite === false) {
      // Keep only leads without an own website (social OK, directory/unknown excluded)
      const cat = classifyWebsiteUrl(lead.website);
      if (cat === 'own_website' || cat === 'directory' || cat === 'unknown') return false;
      // social_media and none pass
    }
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
  const out = {
    status,
    results,
    errorCode: raw.errorCode || null,
    errorMessage: raw.errorMessage || null,
    errorStage: raw.errorStage || null,
    httpStatus: raw.httpStatus != null ? raw.httpStatus : null,
  };
  // Operational metadata for reconciliation / quotas (never sent to public client as-is)
  if (raw.metrics && typeof raw.metrics === 'object') out.metrics = raw.metrics;
  if (raw.externalRunId) out.externalRunId = String(raw.externalRunId);
  if (raw.runId) out.runId = String(raw.runId);
  if (raw.snapshotId) out.snapshotId = String(raw.snapshotId);
  if (raw.pendingRemote != null) out.pendingRemote = Boolean(raw.pendingRemote);
  return out;
}

async function runProviderSafe(provider, criteria, signal, opts = {}) {
  const code = provider && provider.code ? provider.code : 'unknown';
  if (!provider || typeof provider.search !== 'function') {
    return { code, result: { status: 'error', results: [], errorCode: 'PROVIDER_MISSING', errorMessage: 'missing search', errorStage: null, httpStatus: null } };
  }
  try {
    // Providers accept (criteria, signal) or (criteria, { signal, onRemoteStarted })
    const second = opts && (opts.onRemoteStarted || opts.geoBlockedProviders)
      ? { signal, onRemoteStarted: opts.onRemoteStarted || null }
      : signal;
    const raw = await provider.search(criteria, second);
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
  dataforseo,
  tomtom,
  // historical (not selected for new searches unless explicitly injected)
  apify,
  brightdata,
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
  // Propagate optional geographic context only when present and valid. Never invent.
  const { toIso2Country } = require('./providers/countryCodes');
  const country = toIso2Country(input.country);
  if (country) baseCriteria.country = country;
  const latN = input.lat != null ? Number(input.lat) : NaN;
  const lngN =
    input.lng != null ? Number(input.lng)
      : input.long != null ? Number(input.long)
        : NaN;
  if (Number.isFinite(latN) && Number.isFinite(lngN) && latN >= -90 && latN <= 90 && lngN >= -180 && lngN <= 180) {
    baseCriteria.lat = latN;
    baseCriteria.lng = lngN;
  }
  if (input.radius != null && Number.isFinite(Number(input.radius)) && Number(input.radius) > 0) {
    baseCriteria.radius = Number(input.radius);
  }
  if (!baseCriteria.query) { const err = new Error('Categoria/query obrigatória.'); err.code = 'VALIDATION'; throw err; }
  if (!baseCriteria.location) { const err = new Error('Localização obrigatória.'); err.code = 'VALIDATION'; throw err; }
  if (signal && signal.aborted) {
    return { outcome: 'error', searchStatus: 'cancelled', _providers: [], durationMs: 0,
      totals: { raw: 0, normalized: 0, afterDedup: 0, afterFilters: 0, returned: 0, limit: globalLimit }, results: [], cancelled: true };
  }
  const registry = { ...DEFAULT_PROVIDERS, ...(input.providers || {}) };
  // Active allow-list: only dataforseo + tomtom for new searches.
  // Historical providers (apify/brightdata) are never selected unless injected via input.providers for recovery.
  const allowList = Array.isArray(input.allowedProviders) && input.allowedProviders.length
    ? input.allowedProviders.map(String).filter((c) => PROVIDER_CODES.includes(c) || c === 'dataforseo' || c === 'tomtom')
    : PROVIDER_CODES.slice();
  // Force active set intersection with PROVIDER_CODES (excludes apify/brightdata from new runs)
  const activeAllow = PROVIDER_CODES.filter((code) => allowList.includes(code));
  const skippedQuota = PROVIDER_CODES.filter((code) => !activeAllow.includes(code)).map((code) => ({
    code,
    status: 'skipped_quota',
    count: 0,
    metrics: { rawCount: 0, apiCalls: 0, geocodeCalls: 0 },
  }));
  const started = Date.now();
  const internalProviders = skippedQuota.slice();
  const allRaw = [];

  function pushProviderResult(pr) {
    const r = pr.result;
    const metrics = r.metrics || {
      rawCount: Array.isArray(r.results) ? r.results.length : 0,
      apiCalls: 0,
      geocodeCalls: 0,
    };
    if (r.externalRunId && !metrics.externalRunId) metrics.externalRunId = r.externalRunId;
    if (r.runId && !metrics.runId) metrics.runId = r.runId;
    if (r.snapshotId && !metrics.snapshotId) metrics.snapshotId = r.snapshotId;
    if (r.requestSent != null) metrics.requestSent = Boolean(r.requestSent);
    internalProviders.push({
      code: pr.code,
      status: r.status,
      count: Array.isArray(r.results) ? r.results.length : 0,
      metrics,
      externalRunId: r.externalRunId || r.runId || r.snapshotId || null,
      errorCode: r.errorCode,
      errorMessage: r.errorMessage,
      errorStage: r.errorStage,
      httpStatus: r.httpStatus,
      requestSent: r.requestSent != null ? Boolean(r.requestSent) : undefined,
    });
    for (const item of (r.results || [])) allRaw.push(item);
  }

  // ---- 1) DataForSEO (primary) ----
  let dataforseoOk = false;
  let dataforseoUniqueCount = 0;
  let dataforseoLeads = [];

  if (activeAllow.includes('dataforseo')) {
    const p = registry.dataforseo;
    const bound = (!p || typeof p.search !== 'function')
      ? { code: 'dataforseo', search: null }
      : { code: 'dataforseo', search: p.search.bind(p) };
    if (onProviderProgress) {
      try { onProviderProgress({ code: 'dataforseo', status: 'running', count: 0 }); } catch (_) {}
    }
    const dfsCriteria = {
      ...baseCriteria,
      limit: globalLimit, // depth matches requested limit
      searchId: input.searchId || null,
    };
    if (Array.isArray(input.geoBlockedProviders) && input.geoBlockedProviders.includes('dataforseo')) {
      dfsCriteria.geoBlocked = true;
    }
    if (input.existingTaskId) dfsCriteria.existingTaskId = input.existingTaskId;
    const out = await runProviderSafe(bound, dfsCriteria, signal, {
      onRemoteStarted: opts.onRemoteStarted || null,
    });
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
    pushProviderResult(out);

    if (signal && signal.aborted) {
      return {
        outcome: 'error', searchStatus: 'cancelled',
        _providers: internalProviders.map((pr) => ({ ...pr, status: pr.status === 'running' ? 'cancelled' : pr.status })),
        durationMs: Date.now() - started,
        totals: { raw: 0, normalized: 0, afterDedup: 0, afterFilters: 0, returned: 0, limit: globalLimit },
        results: [], cancelled: true,
      };
    }

    const dfsStatus = out.result.status;
    if (dfsStatus === 'ok' || dfsStatus === 'empty') {
      dataforseoOk = true;
      const normalizedDfs = [];
      for (const item of (out.result.results || [])) {
        const n = normalizeLead(item);
        if (n) normalizedDfs.push(n);
      }
      dataforseoLeads = deduplicate(normalizedDfs);
      dataforseoUniqueCount = applyFilters(dataforseoLeads, baseCriteria.filters).length;
    } else {
      // Hard failure of primary: do NOT call TomTom as fallback
      dataforseoOk = false;
    }
  } else {
    internalProviders.push({
      code: 'dataforseo',
      status: 'skipped_quota',
      count: 0,
      metrics: { rawCount: 0, apiCalls: 0, geocodeCalls: 0 },
    });
  }

  // ---- 2) TomTom complementary only if primary succeeded and still missing results ----
  const missing = globalLimit - dataforseoUniqueCount;
  const shouldCallTomTom =
    dataforseoOk &&
    missing > 0 &&
    activeAllow.includes('tomtom');

  if (shouldCallTomTom) {
    const p = registry.tomtom;
    const bound = (!p || typeof p.search !== 'function')
      ? { code: 'tomtom', search: null }
      : { code: 'tomtom', search: p.search.bind(p) };
    if (onProviderProgress) {
      try { onProviderProgress({ code: 'tomtom', status: 'running', count: 0 }); } catch (_) {}
    }
    const tomtomLimit = Math.min(100, missing);
    const tomtomCriteria = {
      ...baseCriteria,
      limit: tomtomLimit,
    };
    if (Array.isArray(input.geoBlockedProviders) && input.geoBlockedProviders.includes('tomtom')) {
      tomtomCriteria.geoBlocked = true;
    }
    const out = await runProviderSafe(bound, tomtomCriteria, signal, {
      onRemoteStarted: opts.onRemoteStarted || null,
    });
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
    pushProviderResult(out);
  } else if (activeAllow.includes('tomtom')) {
    // Explicitly record that TomTom was not needed or blocked by primary failure / quota skip
    const reason = !dataforseoOk
      ? 'skipped_primary_failed'
      : missing <= 0
        ? 'skipped_sufficient'
        : 'skipped_quota';
    if (!internalProviders.some((p) => p.code === 'tomtom')) {
      internalProviders.push({
        code: 'tomtom',
        status: reason,
        count: 0,
        metrics: { rawCount: 0, apiCalls: 0, geocodeCalls: 0 },
      });
    }
  }

  if (signal && signal.aborted) {
    return {
      outcome: 'error', searchStatus: 'cancelled',
      _providers: internalProviders,
      durationMs: Date.now() - started,
      totals: { raw: 0, normalized: 0, afterDedup: 0, afterFilters: 0, returned: 0, limit: globalLimit },
      results: [], cancelled: true,
    };
  }

  // Combined normalize → dedupe → filters → limit
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
    outcome: classified.outcome,
    searchStatus: classified.searchStatus,
    _providers: internalProviders,
    durationMs: Date.now() - started,
    totals: {
      raw: allRaw.length,
      normalized: normalized.length,
      afterDedup: afterDedup.length,
      afterFilters: afterFilters.length,
      returned: limited.length,
      limit: globalLimit,
      dataforseoUnique: dataforseoUniqueCount,
      tomtomCalled: shouldCallTomTom,
    },
    results: limited,
    cancelled: false,
  };
}

function isSafeGoogleMapsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' &&
      (host === 'google.com' || host.endsWith('.google.com')) &&
      (host === 'maps.google.com' || host.startsWith('maps.') ||
       url.pathname.toLowerCase().startsWith('/maps'));
  } catch (_) {
    return false;
  }
}

function buildMapsUrl(lead = {}) {
  const candidates = [lead.mapsUrl, lead.googleMapsUrl,
    lead.raw && lead.raw.googleMapsUrl, lead.raw && lead.raw.url];

  for (const candidate of candidates) {
    if (isSafeGoogleMapsUrl(candidate)) return candidate.trim();
  }

  const lat = Number(lead.lat);
  const lng = Number(lead.lng);
  if (lead.lat != null && lead.lng != null &&
      Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    return 'https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(`${lat},${lng}`);
  }

  const query = [lead.name, lead.address].filter(
    value => typeof value === 'string' && value.trim()
  ).join(' ').trim();

  if (!query) return null;
  return 'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent(query);
}

/** Google Place IDs typically start with ChIJ. Never treat TomTom/non-Google external IDs as place IDs. */
function isGooglePlaceId(id) {
  if (!id || typeof id !== 'string') return false;
  const s = id.trim();
  return /^ChIJ[A-Za-z0-9_-]{10,}$/.test(s);
}

function publicLead(lead, index) {
  const raw = lead.raw && typeof lead.raw === 'object' ? lead.raw : {};
  let googlePlaceId = null;
  const candidates = [lead.googlePlaceId, raw.placeId, raw.googlePlaceId];
  if ((lead.sourceProvider === 'apify' || lead.sourceProvider === 'brightdata') && isGooglePlaceId(lead.externalId)) {
    candidates.unshift(lead.externalId);
  }
  for (const c of candidates) {
    if (isGooglePlaceId(c)) { googlePlaceId = String(c).trim(); break; }
  }
  let googleMapsUrl = lead.googleMapsUrl || null;
  if (!googleMapsUrl) {
    const candidate = raw.googleMapsUrl || raw.url || null;
    if (candidate && typeof candidate === 'string') googleMapsUrl = candidate;
  }
  return {
    id: lead.id || null, index: index != null ? index : undefined,
    name: lead.name, address: lead.address, phone: lead.phone, email: lead.email, website: lead.website,
    rating: lead.rating, reviewsCount: lead.reviewsCount != null ? lead.reviewsCount : lead.reviews_count,
    category: lead.category, lat: lead.lat, lng: lead.lng, photoUrl: lead.photoUrl || null,
    googleMapsUrl: googleMapsUrl || null,
    mapsUrl: buildMapsUrl({ ...lead, googleMapsUrl }),
    googlePlaceId: googlePlaceId || null,
  };
}

/**
 * Stable per-user identity for saved leads (dedupe across searches/providers).
 * Priority: normalized phone (>=8 digits) → "p:<digits>";
 * else normalized name + address → "na:<name>|<addr48>";
 * else name only → "n:<name>".
 * Same name with different addresses are distinct.
 */
function leadIdentityKey(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const phone = normalizePhone(lead.phone);
  if (phone && phone.length >= 8) return 'p:' + phone;
  const name = normalizeText(lead.name);
  const addr = normalizeText(lead.address);
  if (name && addr && addr.length >= 4) return 'na:' + name + '|' + addr.slice(0, 48);
  if (name && name.length >= 4) return 'n:' + name;
  return null;
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
  classifyWebsiteUrl, SOCIAL_MEDIA_DOMAINS, DIRECTORY_DOMAINS, WEBSITE_CATEGORY_RANK, pickPreferredWebsite,
  normalizeLead, deduplicate, mergeLeads, applyFilters, perProviderLimit, normalizeProviderResult,
  runProviderSafe, classifySearchOutcome, executeSearch, publicLead, isGooglePlaceId, isSafeGoogleMapsUrl, buildMapsUrl, leadIdentityKey, clientMessageForOutcome, clientHintForOutcome,
  MODALITIES: { standard: { id: 'standard', providerCodes: PROVIDER_CODES } },
  resolveModality: () => ({ id: 'standard', providerCodes: PROVIDER_CODES }),
  providersForModality: () => PROVIDER_CODES.slice(),
  dedupeKey: (lead) => {
    const phone = normalizePhone(lead.phone);
    if (phone && phone.length >= 8) return 'phone:' + phone;
    return 'na:' + normalizeText(lead.name) + '|' + normalizeText(lead.address).slice(0, 48);
  },
};
