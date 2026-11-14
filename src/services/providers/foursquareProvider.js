/**
 * Foursquare Places API adapter (current Places API only).
 * Endpoint: https://places-api.foursquare.com/places/search
 * Auth: Bearer + X-Places-Api-Version
 * Max 50 results (API limit per request). No invented cursor pagination.
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
const MAX_RAW = 50;
const DEFAULT_API_VERSION = '2025-06-17';

function isConfigured() {
  const key = process.env.FOURSQUARE_API_KEY;
  return Boolean(key && String(key).trim().length > 8);
}

function apiKey() {
  return String(process.env.FOURSQUARE_API_KEY || '').trim();
}

function mapItem(p, idx, criteria) {
  const name = p.name || (p.venue && p.venue.name) || null;
  if (!name) return null;

  const loc = p.location || {};
  const geo = (p.geocodes && p.geocodes.main) || {};

  const address =
    loc.formatted_address ||n    loc.address ||
    [loc.address, loc.locality, loc.region].filter(Boolean).join(', ') ||
    null;

  let lat = null;
  let lng = null;
  if (p.latitude != null && Number.isFinite(Number(p.latitude))) lat = Number(p.latitude);
  else if (loc.latitude != null && Number.isFinite(Number(loc.latitude))) lat = Number(loc.latitude);
  else if (geo.latitude != null && Number.isFinite(Number(geo.latitude))) lat = Number(geo.latitude);

  if (p.longitude != null && Number.isFinite(Number(p.longitude))) lng = Number(p.longitude);
  else if (loc.longitude != null && Number.isFinite(Number(loc.longitude))) lng = Number(loc.longitude);
  else if (geo.longitude != null && Number.isFinite(Number(geo.longitude))) lng = Number(geo.longitude);

  const categories = Array.isArray(p.categories) ? p.categories : [];
  const catName = (categories[0] && categories[0].name) || categories[0] || criteria.query;

  let photo = null;
  if (p.photos && p.photos[0] && p.photos[0].prefix && p.photos[0].suffix) {
    photo = p.photos[0].prefix + '512x512' + p.photos[0].suffix;
  }

  return {
    name: String(name).trim(),
    address: address ? String(address).trim() : null,
    phone: p.tel || p.phone || null,
    email: p.email || null,
    website: p.website || p.link || null,
    rating: typeof p.rating === 'number' ? p.rating : null,
    reviewsCount:
      p.stats && typeof p.stats.total_ratings === 'number'
        ? p.stats.total_ratings
        : typeof p.total_ratings === 'number'
          ? p.total_ratings
          : null,
    category: catName,
    lat: lat,
    lng: lng,
    photoUrl: photo,
    sourceProvider: CODE,
    externalId: p.fsq_id || p.fsq_place_id || p.id || 'fsq-' + idx,
    raw: { fsq_id: p.fsq_id || p.fsq_place_id || p.id },
  };
}

async function search(criteria, opts) {
  opts = opts || {};
  if (!isConfigured()) return notConfigured(CODE);
  const signal = opts.signal;
  const key = apiKey();
  const query = String(criteria.query || '').trim();
  const location = String(criteria.location || '').trim();
  const want = Math.min(Math.max(Number(criteria.limit) || 50, 1), MAX_RAW);

  const base = 'https://places-api.foursquare.com/places/search';
  const headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + key,
    'X-Places-Api-Version': process.env.FOURSQUARE_API_VERSION || DEFAULT_API_VERSION,
  };

  try {
    if (signal && signal.aborted) {
      var err = new Error('cancelled');
      err.code = 'CANCELLED';
      throw err;
    }

    var params = new URLSearchParams();
    params.set('query', query);
    if (location) params.set('near', location);
    params.set('limit', String(Math.min(MAX_PER_PAGE, want)));

    var url = base + '?' + params.toString();
    var payload = await withTimeout(
      fetch(url, { method: 'GET', headers: headers, signal: signal }).then(async function (res) {
        if (!res.ok) {
          var text = await res.text().catch(function () { return ''; });
          throw Object.assign(new Error('HTTP ' + res.status + ' ' + text.slice(0, 120)), {
            code: 'HTTP_ERROR',
            httpStatus: res.status,
          });
        }
        return res.json();
      }),
      Math.max(DEFAULT_TIMEOUT_MS, 30000),
      CODE
    );

    var results = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload)
        ? payload
        : [];

    var all = [];
    for (var i = 0; i < results.length && all.length < want; i++) {
      var item = mapItem(results[i], all.length, criteria);
      if (item) all.push(item);
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
  isConfigured: isConfigured,
  search: search,
  mapItem: mapItem,
  MAX_RAW: MAX_RAW,
};
