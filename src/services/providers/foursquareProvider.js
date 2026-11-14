/**
 * Foursquare Places API adapter (current Places API only).
 * Endpoint: https://places-api.foursquare.com/places/search
 * Auth: Bearer service key + X-Places-Api-Version
 * Max 50 per request. Cursor pagination when the API returns next_cursor / Link header.
 * No automatic fallback to deprecated V3 endpoints.
 */
const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'foursquare';
const MAX_PER_PAGE = 50;
const MAX_RAW = 200;
const DEFAULT_API_VERSION = '2025-06-17';

/**
 * Explicit boolean env parsing.
 * true for: 1, true, yes (case-insensitive, trimmed)
 * false for: 0, false, no, empty, absent, or any other value
 */
function parseEnvBool(value) {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  if (!v) return false;
  return v === '1' || v === 'true' || v === 'yes';
}

function isConfigured() {
  const key = process.env.FOURSQUARE_API_KEY;
  return Boolean(key && String(key).trim().length > 8);
}

function apiKey() {
  return String(process.env.FOURSQUARE_API_KEY || '').trim();
}

function mapItem(p, idx, criteria) {
  const name = p.name || p.venue?.name || null;
  if (!name) return null;
  const location = p.location || p.geocodes?.main || {};
  const address =
    p.location?.formatted_address ||
    p.location?.address ||
    [p.location?.address, p.location?.locality, p.location?.region]
      .filter(Boolean)
      .join(', ') ||
    null;
  const lat =
    location.latitude != null
      ? Number(location.latitude)
      : p.geocodes?.main?.latitude != null
        ? Number(p.geocodes.main.latitude)
        : null;
  const lng =
    location.longitude != null
      ? Number(location.longitude)
      : p.geocodes?.main?.longitude != null
        ? Number(p.geocodes.main.longitude)
        : null;
  const categories = Array.isArray(p.categories) ? p.categories : [];
  const catName = categories[0]?.name || categories[0] || criteria.query;
  const photo =
    p.photos && p.photos[0]
      ? `${p.photos[0].prefix}300x300${p.photos[0].suffix}`
      : null;
  return {
    name: String(name).trim(),
    address: address ? String(address).trim() : null,
    phone: p.tel || p.phone || null,
    email: p.email || null,
    website: p.website || p.link || null,
    rating: typeof p.rating === 'number' ? p.rating : null,
    reviewsCount:
      typeof p.stats?.total_ratings === 'number'
        ? p.stats.total_ratings
        : typeof p.total_ratings === 'number'
          ? p.total_ratings
          : null,
    category: catName,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    photoUrl: photo,
    sourceProvider: CODE,
    externalId: p.fsq_id || p.fsq_place_id || p.id || `fsq-${idx}`,
    raw: { fsq_id: p.fsq_id || p.fsq_place_id || p.id },
  };
}

async function fetchPage(url, headers, signal) {
  return withTimeout(
    fetch(url, {
      method: 'GET',
      headers,
      signal,
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 120)}`), {
          code: 'HTTP_ERROR',
          httpStatus: res.status,
        });
      }
      const data = await res.json();
      const link = res.headers.get('link') || res.headers.get('Link') || '';
      return { data, link };
    }),
    Math.max(DEFAULT_TIMEOUT_MS, 30000),
    CODE
  );
}

/**
 * @param {object} criteria
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function search(criteria, opts = {}) {
  if (!isConfigured()) return notConfigured(CODE);
  const signal = opts.signal;
  const key = apiKey();
  const query = String(criteria.query || '').trim();
  const location = String(criteria.location || '').trim();
  const want = Math.min(Math.max(Number(criteria.limit) || 100, 1), MAX_RAW);
  const near = location || undefined;

  // Force current Places API. FOURSQUARE_USE_V3 is kept only for explicit opt-in tests;
  // when true we still use the current endpoint (V3 is deprecated).
  // parseEnvBool ensures "0" / "false" / "no" are treated as false.
  const _legacyFlag = parseEnvBool(process.env.FOURSQUARE_USE_V3);
  void _legacyFlag; // retained for env compatibility / tests; does not switch endpoint

  const base = 'https://places-api.foursquare.com/places/search';
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
    'X-Places-Api-Version': process.env.FOURSQUARE_API_VERSION || DEFAULT_API_VERSION,
  };

  try {
    const all = [];
    let cursor = null;
    let pages = 0;
    const maxPages = 6;

    while (all.length < want && pages < maxPages) {
      if (signal && signal.aborted) {
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        throw err;
      }

      const params = new URLSearchParams();
      params.set('query', query);
      if (near) params.set('near', near);
      params.set('limit', String(Math.min(MAX_PER_PAGE, want - all.length)));
      if (cursor) params.set('cursor', cursor);

      const url = `${base}?${params.toString()}`;
      const payload = await fetchPage(url, headers, signal);

      const results = Array.isArray(payload.data?.results)
        ? payload.data.results
        : Array.isArray(payload.data)
          ? payload.data
          : [];

      if (!results.length) break;

      for (const p of results) {
        const item = mapItem(p, all.length, criteria);
        if (item) all.push(item);
        if (all.length >= want) break;
      }

      // Official cursor support: next_cursor field or Link header
      let next = payload.data?.next_cursor || null;
      if (!next && payload.link) {
        const linkMatch = /[?&]cursor=([^&>]+)/.exec(payload.link);
        if (linkMatch) next = decodeURIComponent(linkMatch[1]);
      }
      if (!next) break;
      // Guard against repeating the same cursor
      if (next === cursor) break;
      cursor = next;
      pages += 1;
    }

    return okResult(all.slice(0, want));
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      return errorResult('CANCELLED', 'Foursquare search cancelled');
    }
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'foursquare failed');
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  mapItem,
  parseEnvBool,
};
