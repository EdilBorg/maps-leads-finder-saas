/**
 * TomTom Places / POI Search API adapter.
 * Docs: https://developer.tomtom.com/search-api/documentation/search-service/points-of-interest-search
 * Key only on server. Supports offset pagination (limit max 100 per call).
 */
const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'tomtom';
const MAX_PER_PAGE = 100;
const MAX_RAW = 200;

function isConfigured() {
  const key = process.env.TOMTOM_API_KEY;
  return Boolean(key && String(key).trim().length > 8);
}

function apiKey() {
  return String(process.env.TOMTOM_API_KEY || '').trim();
}

function mapItem(r, idx, criteria) {
  const poi = r.poi || {};
  const addr = r.address || {};
  const pos = r.position || {};
  const name = poi.name || r.name || null;
  if (!name) return null;
  const phone =
    (poi.phone && String(poi.phone)) ||
    (Array.isArray(poi.phones) && poi.phones[0]) ||
    null;
  const website =
    (poi.url && String(poi.url)) ||
    (Array.isArray(poi.urls) && poi.urls[0]) ||
    null;
  const categories = Array.isArray(poi.categories) ? poi.categories : [];
  return {
    name: String(name).trim(),
    address: addr.freeformAddress || addr.streetName || null,
    phone: phone ? String(phone).trim() : null,
    email: null,
    website: website ? String(website).trim() : null,
    rating: null,
    reviewsCount: null,
    category: categories[0] || criteria.query,
    lat: pos.lat != null ? Number(pos.lat) : null,
    lng: pos.lon != null ? Number(pos.lon) : pos.lng != null ? Number(pos.lng) : null,
    photoUrl: null,
    sourceProvider: CODE,
    externalId: r.id != null ? String(r.id) : `tomtom-${idx}`,
    raw: { id: r.id },
  };
}

function resolveSignal(second) {
  if (!second) return undefined;
  if (typeof second.aborted === 'boolean') return second;
  if (second.signal && typeof second.signal.aborted === 'boolean') return second.signal;
  return undefined;
}

/**
 * @param {object} criteria
 * @param {AbortSignal|{signal?: AbortSignal}} [signalOrOpts]
 */
async function search(criteria, signalOrOpts) {
  if (!isConfigured()) return notConfigured(CODE);
  const signal = resolveSignal(signalOrOpts);
  const key = apiKey();
  const query = String(criteria.query || '').trim();
  const location = String(criteria.location || '').trim();
  const want = Math.min(Math.max(Number(criteria.limit) || 100, 1), MAX_RAW);
  const q = encodeURIComponent(`${query} ${location}`.trim());

  try {
    const all = [];
    let ofs = 0;
    while (all.length < want) {
      if (signal && signal.aborted) {
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        throw err;
      }
      const pageSize = Math.min(MAX_PER_PAGE, want - all.length);
      const url =
        `https://api.tomtom.com/search/2/poiSearch/${q}.json` +
        `?key=${encodeURIComponent(key)}&limit=${pageSize}&ofs=${ofs}&language=pt-PT`;

      const data = await withTimeout(
        fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal,
        }).then(async (res) => {
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 120)}`), {
              code: 'HTTP_ERROR',
              httpStatus: res.status,
            });
          }
          return res.json();
        }),
        Math.max(DEFAULT_TIMEOUT_MS, 30000),
        CODE
      );

      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) break;
      for (const r of results) {
        const item = mapItem(r, all.length, criteria);
        if (item) all.push(item);
        if (all.length >= want) break;
      }
      if (results.length < pageSize) break;
      ofs += results.length;
      if (ofs >= 2000) break;
    }
    return okResult(all.slice(0, want));
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      return errorResult('CANCELLED', 'TomTom search cancelled');
    }
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'tomtom failed');
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  mapItem,
};
