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

const { toIso2Country } = require('./countryCodes');

const CODE = 'tomtom';
const MAX_PER_PAGE = 100;
const MAX_RAW = 200;
const DEFAULT_RADIUS_M = 25000;

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

function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

function buildSearchUrl({ key, query, location, country, lat, lng, radius, pageSize, ofs }) {
  const term = String(query || '').trim();
  const loc = String(location || '').trim();
  // With valid coordinates: pure category term + lat/lon/radius.
  // Without coordinates: always include location in the text query so the city
  // is never dropped (even when countrySet is present as a geographic filter).
  let pathQuery = term;
  if (isValidLatLng(lat, lng)) {
    pathQuery = term;
  } else if (loc) {
    pathQuery = `${term} ${loc}`.trim();
  }
  const q = encodeURIComponent(pathQuery || term || 'business');

  const params = new URLSearchParams();
  params.set('key', key);
  params.set('limit', String(pageSize));
  params.set('ofs', String(ofs));
  params.set('language', process.env.TOMTOM_LANGUAGE || 'pt-PT');

  if (country) params.set('countrySet', country);
  if (isValidLatLng(lat, lng)) {
    params.set('lat', String(lat));
    params.set('lon', String(lng));
    params.set('radius', String(radius || DEFAULT_RADIUS_M));
  }

  return `https://api.tomtom.com/search/2/poiSearch/${q}.json?${params.toString()}`;
}

/**
 * Geocode a location string.
 * Returns a structured result — never collapses distinct failures into a silent null
 * at the call site without a reason code.
 *
 * @returns {Promise<
 *   | { ok: true, lat: number, lng: number, country: string|null }
 *   | { ok: false, code: string, message: string, httpStatus?: number }
 * >}
 */
async function geocodeLocation(location, signal, preferredCountry) {
  const key = apiKey();
  if (!key) {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'TomTom API key missing' };
  }
  if (!location || !String(location).trim()) {
    return { ok: false, code: 'GEOCODE_NOT_FOUND', message: 'Empty location' };
  }

  let url =
    'https://api.tomtom.com/search/2/geocode/' +
    encodeURIComponent(String(location).trim()) +
    '.json?key=' +
    encodeURIComponent(key) +
    '&limit=5';
  if (preferredCountry) {
    url += '&countrySet=' + encodeURIComponent(preferredCountry);
  }

  try {
    const res = await withTimeout(
      (sig) => fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: sig }),
      Math.max(DEFAULT_TIMEOUT_MS, 15000),
      signal || (CODE + '-geocode')
    );

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { ok: false, code: 'AUTH_ERROR', message: 'TomTom geocode auth failed', httpStatus: res.status };
      }
      if (res.status === 429) {
        return { ok: false, code: 'RATE_LIMIT', message: 'TomTom geocode rate limited', httpStatus: 429 };
      }
      return {
        ok: false,
        code: 'HTTP_ERROR',
        message: 'TomTom geocode HTTP ' + res.status,
        httpStatus: res.status,
      };
    }

    let data;
    try {
      data = await res.json();
    } catch (_) {
      return { ok: false, code: 'INVALID_RESPONSE', message: 'TomTom geocode response not JSON' };
    }

    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      return { ok: false, code: 'GEOCODE_NOT_FOUND', message: 'Location not found' };
    }

    // Score results by country match when preferredCountry is set.
    const scored = results.map((r) => {
      const a = r.address || {};
      const c2 = toIso2Country(a.countryCode);
      const c3 = toIso2Country(a.countryCodeISO3);
      const country = c2 || c3 || null;
      const pos = r.position || {};
      const lat = Number(pos.lat);
      const lng = Number(pos.lon != null ? pos.lon : pos.lng);
      const countryMatch = preferredCountry ? country === preferredCountry : true;
      return { lat, lng, country, countryMatch, raw: r };
    }).filter((s) => isValidLatLng(s.lat, s.lng));

    if (!scored.length) {
      return { ok: false, code: 'GEOCODE_NOT_FOUND', message: 'No valid coordinates in geocode response' };
    }

    if (preferredCountry) {
      const matching = scored.filter((s) => s.countryMatch);
      if (!matching.length) {
        // Do not silently accept a result from a different country.
        return {
          ok: false,
          code: 'GEOCODE_COUNTRY_MISMATCH',
          message: 'Geocode result country does not match requested country',
        };
      }
      if (matching.length > 1 && matching[0].country !== preferredCountry) {
        // Ambiguous within the preferred country is still acceptable — pick first match.
      }
      const chosen = matching[0];
      return { ok: true, lat: chosen.lat, lng: chosen.lng, country: chosen.country || preferredCountry };
    }

    // No preferred country: if multiple results span different countries, treat as ambiguous.
    const countries = new Set(scored.map((s) => s.country).filter(Boolean));
    if (countries.size > 1) {
      return {
        ok: false,
        code: 'GEOCODE_AMBIGUOUS',
        message: 'Location is ambiguous across multiple countries',
      };
    }

    const chosen = scored[0];
    return { ok: true, lat: chosen.lat, lng: chosen.lng, country: chosen.country };
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      return { ok: false, code: 'CANCELLED', message: 'Geocode cancelled' };
    }
    if (err && err.code === 'PROVIDER_TIMEOUT') {
      return { ok: false, code: 'TIMEOUT', message: err.message || 'Geocode timeout' };
    }
    return { ok: false, code: 'NETWORK_ERROR', message: (err && err.message) || 'Geocode network error' };
  }
}

async function search(criteria, signalOrOpts) {
  if (!isConfigured()) return notConfigured(CODE);
  const signal = resolveSignal(signalOrOpts);
  const key = apiKey();
  const query = String(criteria.query || '').trim();
  const location = String(criteria.location || '').trim();
  const want = Math.min(Math.max(Number(criteria.limit) || 100, 1), MAX_RAW);

  let country = toIso2Country(criteria.country);
  let lat = criteria.lat != null ? Number(criteria.lat) : NaN;
  let lng =
    criteria.lng != null
      ? Number(criteria.lng)
      : criteria.long != null
        ? Number(criteria.long)
        : NaN;
  let geocodeCalls = 0;

  try {
    if ((!isValidLatLng(lat, lng) || !country) && location) {
      const geo = await geocodeLocation(location, signal, country);
      geocodeCalls = 1;
      if (geo.ok) {
        if (!isValidLatLng(lat, lng)) {
          lat = geo.lat;
          lng = geo.lng;
        }
        if (!country && geo.country) country = geo.country;
      } else if (geo.code === 'CANCELLED') {
        return errorResult('CANCELLED', 'TomTom search cancelled');
      } else if (geo.code === 'AUTH_ERROR' || geo.code === 'RATE_LIMIT') {
        return errorResult(geo.code, geo.message, {
          errorStage: 'geocode',
          httpStatus: geo.httpStatus || null,
        });
      }
      // GEOCODE_NOT_FOUND / AMBIGUOUS / COUNTRY_MISMATCH: continue without coords
      // (structured search may still work with country only, or free-text fallback).
    }

    const all = [];
    let ofs = 0;
    let apiCalls = 0;
    let rawCount = 0;
    while (all.length < want) {
      if (signal && signal.aborted) {
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        throw err;
      }
      const pageSize = Math.min(MAX_PER_PAGE, want - all.length);
      const url = buildSearchUrl({
        key,
        query,
        location,
        country,
        lat,
        lng,
        radius: criteria.radius || DEFAULT_RADIUS_M,
        pageSize,
        ofs,
      });

      apiCalls += 1;
      const data = await withTimeout(
        (sig) =>
          fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: sig,
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
        signal || CODE
      );

      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) break;
      for (const r of results) {
        rawCount += 1;
        const item = mapItem(r, all.length, criteria);
        if (item) all.push(item);
        if (all.length >= want) break;
      }
      if (results.length < pageSize) break;
      ofs += results.length;
      if (ofs >= 2000) break;
    }
    return okResult(all.slice(0, want), {
      rawCount,
      apiCalls,
      geocodeCalls,
    });
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      return errorResult('CANCELLED', 'TomTom search cancelled');
    }
    if (err && err.code === 'PROVIDER_TIMEOUT') {
      return errorResult('TIMEOUT', err.message || 'TomTom timeout', { errorStage: 'search' });
    }
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'tomtom failed', {
      httpStatus: err.httpStatus || null,
      errorStage: 'search',
    });
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  mapItem,
  buildSearchUrl,
  geocodeLocation,
  MAX_RAW,
  DEFAULT_RADIUS_M,
};
