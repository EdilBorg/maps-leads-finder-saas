/**
 * Foursquare Places API adapter (current Places API).
 * Primary: places-api.foursquare.com/places/search with Bearer service key.
 * Fallback: api.foursquare.com/v3/places/search with Authorization API key.
 * Max 50 per request; paginate with cursor when available.
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

  const useBearer = !process.env.FOURSQUARE_USE_V3;
  const base = useBearer
    ? 'https://places-api.foursquare.com/places/search'
    : 'https://api.foursquare.com/v3/places/search';
  const headers = useBearer
    ? {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
        'X-Places-Api-Version': process.env.FOURSQUARE_API_VERSION || '2025-06-17',
      }
    : {
        Accept: 'application/json',
        Authorization: key,
      };

  try {
    const all = [];
    let cursor = null;
    let pages = 0;
    while (all.length < want && pages < 6) {
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
      let payload;
      try {
        payload = await fetchPage(url, headers, signal);
      } catch (err) {
        if (useBearer && pages === 0 && (err.httpStatus === 401 || err.httpStatus === 404)) {
          const v3Base = 'https://api.foursquare.com/v3/places/search';
          const v3Headers = { Accept: 'application/json', Authorization: key };
          payload = await fetchPage(`${v3Base}?${params.toString()}`, v3Headers, signal);
        } else {
          throw err;
        }
      }

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

      cursor =
        payload.data?.next_cursor ||
        null;
      const linkMatch = /cursor=([^&>]+)/.exec(payload.link || '');
      if (!cursor && linkMatch) cursor = decodeURIComponent(linkMatch[1]);
      if (!cursor) break;
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
};
