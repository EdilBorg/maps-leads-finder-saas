/**
 * TomTom Places Search API — Discover v3 (Orbis).
 * Docs: https://docs.tomtom.com/places-search-api/documentation/places-search/discover
 *
 * Discover: POST https://api.tomtom.com/maps/orbis/places/discover
 * Headers: TomTom-Api-Key, TomTom-Api-Version: 3, Attributes
 * maxResults: 1–100 (hard max 100). One Discover call per search from the engine.
 *
 * Geocoding remains Search API v2 (/search/2/geocode) and MUST NOT consume the
 * Discover global quota of 5000 calls/month.
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
const DISCOVER_URL = 'https://api.tomtom.com/maps/orbis/places/discover';
const MAX_PER_PAGE = 100;
/** Hard ceiling for a single Discover call (engine also enforces one call). */
const MAX_RAW = 100;
const DEFAULT_RADIUS_M = 25000;

function isConfigured() {
  const key = process.env.TOMTOM_API_KEY;
  return Boolean(key && String(key).trim().length > 8);
}

function apiKey() {
  return String(process.env.TOMTOM_API_KEY || '').trim();
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

/**
 * Map Discover v3 result item to internal lead contract.
 */
/**
 * Map Discover v3 result item to internal lead contract.
 * Official schema (docs.tomtom.com Places Search Discover):
 *   title, subtitles[], position.coordinates [lon, lat],
 *   address.{street,houseNumber,municipality,postalCode,country,...},
 *   contacts[].{phones[], websites[]}, poiTypes[].{id,name}, id, type
 */
function mapDiscoverItem(r, idx, criteria) {
  if (!r || typeof r !== 'object') return null;

  // Official field is `title` (not name)
  const name =
    r.title ||
    r.name ||
    (r.poi && r.poi.name) ||
    null;
  if (!name || !String(name).trim()) return null;

  // Address: structured fields or subtitles fallback
  const addrObj = r.address && typeof r.address === 'object' ? r.address : {};
  let address = null;
  if (addrObj.freeformAddress) {
    address = String(addrObj.freeformAddress).trim();
  } else {
    const parts = [
      [addrObj.street, addrObj.houseNumber].filter(Boolean).join(' '),
      addrObj.municipality || addrObj.municipalitySubdivision,
      addrObj.postalCode,
      addrObj.country,
    ].filter(Boolean);
    if (parts.length) address = parts.join(', ');
  }
  if (!address && Array.isArray(r.subtitles) && r.subtitles.length) {
    address = r.subtitles.filter((s) => s && String(s).trim()).join(', ') || null;
  }

  // Contacts: contacts[].phones / contacts[].websites
  let phone = null;
  let website = null;
  if (Array.isArray(r.contacts)) {
    for (const c of r.contacts) {
      if (!c || typeof c !== 'object') continue;
      if (!phone && Array.isArray(c.phones) && c.phones.length) {
        phone = String(c.phones[0]).trim() || null;
      }
      if (!website && Array.isArray(c.websites) && c.websites.length) {
        website = String(c.websites[0]).trim() || null;
      }
      if (phone && website) break;
    }
  }
  // Legacy fallbacks (old poiSearch-style payloads)
  if (!phone) {
    const poi = r.poi || {};
    phone =
      (poi.phone && String(poi.phone).trim()) ||
      (Array.isArray(poi.phones) && poi.phones[0] && String(poi.phones[0]).trim()) ||
      (r.phone && String(r.phone).trim()) ||
      null;
  }
  if (!website) {
    const poi = r.poi || {};
    website =
      (poi.url && String(poi.url).trim()) ||
      (Array.isArray(poi.urls) && poi.urls[0] && String(poi.urls[0]).trim()) ||
      (r.url && String(r.url).trim()) ||
      null;
  }

  // Position: GeoJSON Point coordinates [longitude, latitude]
  let lat = null;
  let lng = null;
  if (r.position && typeof r.position === 'object') {
    if (Array.isArray(r.position.coordinates) && r.position.coordinates.length >= 2) {
      lng = Number(r.position.coordinates[0]);
      lat = Number(r.position.coordinates[1]);
    } else {
      // Legacy lat/lon
      if (r.position.lat != null) lat = Number(r.position.lat);
      if (r.position.lon != null) lng = Number(r.position.lon);
      else if (r.position.lng != null) lng = Number(r.position.lng);
    }
  }
  if ((lat == null || lng == null) && r.geometry && Array.isArray(r.geometry.coordinates)) {
    const coords = r.geometry.coordinates;
    if (coords.length >= 2) {
      lng = Number(coords[0]);
      lat = Number(coords[1]);
    }
  }
  if (!Number.isFinite(lat)) lat = null;
  if (!Number.isFinite(lng)) lng = null;

  // Category from poiTypes[].name (preferred role first)
  let category = null;
  if (Array.isArray(r.poiTypes) && r.poiTypes.length) {
    const preferred = r.poiTypes.find((t) => t && t.role === 'preferred') || r.poiTypes[0];
    if (preferred) {
      category = preferred.name || preferred.id || null;
    }
  }
  if (!category && r.poi && Array.isArray(r.poi.categories) && r.poi.categories[0]) {
    category = r.poi.categories[0];
  }
  if (!category) category = criteria.query || null;

  const externalId =
    r.id != null ? String(r.id) : r.placeId != null ? String(r.placeId) : `tomtom-${idx}`;

  return {
    name: String(name).trim(),
    address: address ? String(address).trim() : null,
    phone: phone || null,
    email: null,
    website: website || null,
    rating: null,
    reviewsCount: null,
    category: category ? String(category).trim() : null,
    lat,
    lng,
    photoUrl: null,
    sourceProvider: CODE,
    externalId,
    raw: { id: r.id != null ? r.id : null, type: r.type || null },
  };
}

/** Legacy alias for tests. */
function mapItem(r, idx, criteria) {
  return mapDiscoverItem(r, idx, criteria);
}

/**
 * Geocode via Search API v2. Does NOT count against Discover global quota.
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

    const scored = results.map((r) => {
      const a = r.address || {};
      const c2 = toIso2Country(a.countryCode);
      const c3 = toIso2Country(a.countryCodeISO3);
      const country = c2 || c3 || null;
      const pos = r.position || {};
      const latN = Number(pos.lat);
      const lngN = Number(pos.lon != null ? pos.lon : pos.lng);
      const countryMatch = preferredCountry ? country === preferredCountry : true;
      return { lat: latN, lng: lngN, country, countryMatch, raw: r };
    }).filter((s) => isValidLatLng(s.lat, s.lng));

    if (!scored.length) {
      return { ok: false, code: 'GEOCODE_NOT_FOUND', message: 'No valid coordinates in geocode response' };
    }

    if (preferredCountry) {
      const matching = scored.filter((s) => s.countryMatch);
      if (!matching.length) {
        return {
          ok: false,
          code: 'GEOCODE_COUNTRY_MISMATCH',
          message: 'Geocode result country does not match requested country',
        };
      }
      const chosen = matching[0];
      return { ok: true, lat: chosen.lat, lng: chosen.lng, country: chosen.country || preferredCountry };
    }

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

function buildDiscoverBody({ query, location, country, lat, lng, radius, maxResults }) {
  const term = String(query || '').trim() || 'business';
  const body = {
    query: term,
    maxResults: Math.min(Math.max(Number(maxResults) || 10, 1), MAX_PER_PAGE),
  };

  if (isValidLatLng(lat, lng)) {
    body.origin = {
      type: 'point',
      coordinates: [lng, lat],
    };
    body.preferences = {
      geometry: {
        type: 'point',
        coordinates: [lng, lat],
      },
    };
    const r = Number(radius) || DEFAULT_RADIUS_M;
    if (Number.isFinite(r) && r > 0) {
      body.filters = body.filters || {};
      body.filters.geometry = {
        type: 'circle',
        center: { type: 'point', coordinates: [lng, lat] },
        radiusInMeters: Math.min(Math.max(Math.floor(r), 1), 1000000),
      };
    }
  }

  if (country) {
    body.filters = body.filters || {};
    body.filters.countryCodesIso2 = [String(country).toUpperCase()];
  }

  body.filters = body.filters || {};
  if (!body.filters.types) {
    body.filters.types = ['poi'];
  }

  if (!isValidLatLng(lat, lng) && location) {
    body.query = `${term} ${String(location).trim()}`.trim();
  }

  return body;
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
  let requestSent = false;

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
    }

    const body = buildDiscoverBody({
      query,
      location,
      country,
      lat,
      lng,
      radius: criteria.radius || DEFAULT_RADIUS_M,
      maxResults: want,
    });

    const attributes =
      process.env.TOMTOM_DISCOVER_ATTRIBUTES ||
      'results(id,title,type,position,address,subtitles,contacts,poiTypes,distanceInMeters)';

    requestSent = true;
    const data = await withTimeout(
      (sig) =>
        fetch(DISCOVER_URL, {
          method: 'POST',
          headers: {
            'TomTom-Api-Key': key,
            'TomTom-Api-Version': '3',
            Attributes: attributes,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: sig,
        }).then(async (res) => {
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 120)}`), {
              code: 'HTTP_ERROR',
              httpStatus: res.status,
              requestSent: true,
            });
          }
          return res.json();
        }),
      Math.max(DEFAULT_TIMEOUT_MS, 30000),
      signal || CODE
    );

    const results = Array.isArray(data.results)
      ? data.results
      : Array.isArray(data)
        ? data
        : [];

    const all = [];
    let rawCount = 0;
    for (const r of results) {
      rawCount += 1;
      const item = mapDiscoverItem(r, all.length, criteria);
      if (item) all.push(item);
      if (all.length >= want) break;
    }

    const out = okResult(all.slice(0, want), {
      rawCount,
      apiCalls: 1,
      geocodeCalls,
    });
    out.requestSent = true;
    return out;
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      return errorResult('CANCELLED', 'TomTom search cancelled');
    }
    if (err && err.code === 'PROVIDER_TIMEOUT') {
      const out = errorResult('TIMEOUT', err.message || 'TomTom timeout', { errorStage: 'search' });
      out.requestSent = requestSent || true;
      out.metrics = { rawCount: 0, apiCalls: 1, geocodeCalls };
      return out;
    }
    const out = errorResult(err.code || 'PROVIDER_ERROR', err.message || 'tomtom failed', {
      httpStatus: err.httpStatus || null,
      errorStage: 'search',
    });
    out.requestSent = requestSent || Boolean(err && err.requestSent);
    if (out.requestSent) {
      out.metrics = { rawCount: 0, apiCalls: 1, geocodeCalls };
    }
    return out;
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  mapItem,
  mapDiscoverItem,
  buildDiscoverBody,
  geocodeLocation,
  MAX_RAW,
  MAX_PER_PAGE,
  DEFAULT_RADIUS_M,
  DISCOVER_URL,
};
