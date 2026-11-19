/**
 * Bright Data Google Maps Scraper API adapter (dataset gd_m8ebnr0q2qlklc02fz).
 * Async flow: POST /datasets/v3/trigger → poll /progress/{id} → GET /snapshot/{id}?format=json
 * Discovery: type=discover_new & discover_by=location
 * Geocode: TomTom Search API v2 when criteria has no lat/lng (reuses TOMTOM_API_KEY).
 */
const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'brightdata';
const DEFAULT_DATASET_ID = 'gd_m8ebnr0q2qlklc02fz';
const MAX_RAW = 200;
const POLL_INTERVAL_MS = parseInt(process.env.BRIGHTDATA_POLL_INTERVAL_MS || '2000', 10) || 2000;
const MAX_WAIT_MS = parseInt(process.env.BRIGHTDATA_MAX_WAIT_MS || '180000', 10) || 180000;
const DEFAULT_ZOOM = parseInt(process.env.BRIGHTDATA_ZOOM_LEVEL || '14', 10) || 14;
const API_BASE = 'https://api.brightdata.com';

function isConfigured() {
  const key = process.env.BRIGHTDATA_API_KEY;
  return Boolean(key && String(key).trim().length > 8);
}

function apiKey() {
  return String(process.env.BRIGHTDATA_API_KEY || '').trim();
}

function datasetId() {
  return String(process.env.BRIGHTDATA_DATASET_ID || DEFAULT_DATASET_ID).trim() || DEFAULT_DATASET_ID;
}

function resolveSignal(second) {
  if (!second) return undefined;
  if (typeof second.aborted === 'boolean') return second;
  if (second.signal && typeof second.signal.aborted === 'boolean') return second.signal;
  return undefined;
}

function sleep(ms, signal) {
  if (signal && signal.aborted) {
    const err = new Error('cancelled');
    err.code = 'CANCELLED';
    throw err;
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        reject(err);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Resolve lat/lng/country for discovery input.
 * Prefer explicit criteria fields; otherwise geocode criteria.location via TomTom.
 * @returns {Promise<{ lat: number, lng: number, country: string }|null>}
 */
async function resolveGeo(criteria, signal) {
  const lat = criteria.lat != null ? Number(criteria.lat) : NaN;
  const lng =
    criteria.lng != null
      ? Number(criteria.lng)
      : criteria.long != null
        ? Number(criteria.long)
        : NaN;
  let country = criteria.country != null ? String(criteria.country).trim().toUpperCase() : '';

  if (Number.isFinite(lat) && Number.isFinite(lng) && country && country.length === 2) {
    return { lat, lng, country };
  }

  const location = String(criteria.location || '').trim();
  if (!location) return null;

  const tomtomKey = String(process.env.TOMTOM_API_KEY || '').trim();
  if (!tomtomKey || tomtomKey.length < 8) {
    const fallbackCountry = String(process.env.BRIGHTDATA_DEFAULT_COUNTRY || '').trim().toUpperCase();
    if (fallbackCountry.length === 2 && Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng, country: fallbackCountry };
    }
    return null;
  }

  const url =
    'https://api.tomtom.com/search/2/geocode/' +
    encodeURIComponent(location) +
    '.json?key=' +
    encodeURIComponent(tomtomKey) +
    '&limit=1';

  const res = await withTimeout(
    fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal }),
    Math.max(DEFAULT_TIMEOUT_MS, 15000),
    CODE + '-geocode'
  );
  if (!res.ok) return null;
  const data = await res.json();
  const first = Array.isArray(data.results) && data.results[0] ? data.results[0] : null;
  if (!first || !first.position) return null;
  const gLat = Number(first.position.lat);
  const gLng = Number(first.position.lon != null ? first.position.lon : first.position.lng);
  if (!Number.isFinite(gLat) || !Number.isFinite(gLng)) return null;
  const addr = first.address || {};
  const cc =
    (addr.countryCode && String(addr.countryCode).trim().toUpperCase()) ||
    (addr.countryCodeISO3 ? String(addr.countryCodeISO3).trim().toUpperCase().slice(0, 2) : '') ||
    country ||
    String(process.env.BRIGHTDATA_DEFAULT_COUNTRY || '').trim().toUpperCase();
  if (!cc || cc.length !== 2) return null;
  return { lat: gLat, lng: gLng, country: cc };
}

function buildInput(criteria, geo) {
  const keyword = String(criteria.query || '').trim();
  const zoom =
    criteria.zoom_level != null && Number.isFinite(Number(criteria.zoom_level))
      ? Number(criteria.zoom_level)
      : DEFAULT_ZOOM;
  const limit = Math.min(Math.max(Number(criteria.limit) || 100, 1), MAX_RAW);
  const item = {
    country: geo.country,
    keyword,
    lat: geo.lat,
    long: geo.lng,
    zoom_level: zoom,
  };
  return {
    body: {
      input: [item],
      limit_per_input: limit,
    },
    limit,
  };
}

function mapItem(p, idx) {
  if (!p || typeof p !== 'object') return null;
  const name = p.name != null ? String(p.name).trim() : '';
  if (!name) return null;

  const lat =
    p.lat != null && Number.isFinite(Number(p.lat))
      ? Number(p.lat)
      : p.latitude != null && Number.isFinite(Number(p.latitude))
        ? Number(p.latitude)
        : null;
  const lng =
    p.lon != null && Number.isFinite(Number(p.lon))
      ? Number(p.lon)
      : p.lng != null && Number.isFinite(Number(p.lng))
        ? Number(p.lng)
        : p.longitude != null && Number.isFinite(Number(p.longitude))
          ? Number(p.longitude)
          : null;

  const phone =
    p.phone_number != null
      ? String(p.phone_number).trim()
      : p.phone != null
        ? String(p.phone).trim()
        : null;
  const websiteRaw =
    p.open_website != null
      ? p.open_website
      : p.website != null
        ? p.website
        : null;
  const website =
    websiteRaw != null && String(websiteRaw).trim() && /^https?:\/\//i.test(String(websiteRaw).trim())
      ? String(websiteRaw).trim()
      : websiteRaw != null && String(websiteRaw).trim()
        ? String(websiteRaw).trim()
        : null;

  let rating = p.rating != null ? Number(p.rating) : null;
  if (rating != null && !Number.isFinite(rating)) rating = null;

  const reviewsCount =
    p.reviews_count != null && Number.isFinite(Number(p.reviews_count))
      ? Number(p.reviews_count)
      : null;

  const photoUrl =
    p.main_image != null && typeof p.main_image === 'string' && /^https?:\/\//i.test(p.main_image.trim())
      ? p.main_image.trim()
      : null;

  const googleMapsUrl =
    p.url != null && typeof p.url === 'string' && p.url.trim()
      ? p.url.trim()
      : null;

  const externalId =
    p.place_id != null && String(p.place_id).trim()
      ? String(p.place_id).trim()
      : p.cid != null
        ? String(p.cid)
        : `brightdata-${idx}`;

  return {
    name,
    address: p.address != null ? String(p.address).trim() : null,
    phone: phone || null,
    email: p.email != null ? String(p.email).trim() : null,
    website,
    rating,
    reviewsCount,
    category: p.category != null ? String(p.category).trim() : null,
    lat,
    lng,
    photoUrl,
    googleMapsUrl,
    sourceProvider: CODE,
    externalId,
    raw: {
      place_id: p.place_id || null,
      cid: p.cid || null,
      url: googleMapsUrl,
      country: p.country || p.country_code || null,
    },
  };
}

/**
 * @param {object} criteria
 * @param {AbortSignal|{signal?: AbortSignal}} [signalOrOpts]
 */
async function search(criteria, signalOrOpts) {
  if (!isConfigured()) return notConfigured(CODE);
  const signal = resolveSignal(signalOrOpts);
  const key = apiKey();
  const ds = datasetId();
  let snapshotId = null;

  try {
    if (signal && signal.aborted) {
      const err = new Error('cancelled');
      err.code = 'CANCELLED';
      throw err;
    }

    const geo = await resolveGeo(criteria, signal);
    if (!geo) {
      return errorResult(
        'GEOCODE_FAILED',
        'Não foi possível obter coordenadas válidas para a localização. Verifica a localização ou a chave TomTom.'
      );
    }

    const { body, limit } = buildInput(criteria, geo);
    if (!body.input[0].keyword) {
      return errorResult('VALIDATION', 'Categoria/query obrigatória.');
    }

    const triggerUrl =
      API_BASE +
      '/datasets/v3/trigger?dataset_id=' +
      encodeURIComponent(ds) +
      '&notify=false&include_errors=true&type=discover_new&discover_by=location';

    const startRes = await withTimeout(
      fetch(triggerUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      }),
      Math.max(DEFAULT_TIMEOUT_MS, 30000),
      CODE + '-trigger'
    );

    if (!startRes.ok) {
      const text = await startRes.text().catch(() => '');
      const code =
        startRes.status === 401 || startRes.status === 403
          ? 'AUTH_ERROR'
          : startRes.status === 429
            ? 'RATE_LIMIT'
            : startRes.status >= 500
              ? 'HTTP_ERROR'
              : 'HTTP_ERROR';
      return errorResult(code, 'Bright Data trigger failed: ' + startRes.status + ' ' + text.slice(0, 120));
    }

    let startJson;
    try {
      startJson = await startRes.json();
    } catch (_) {
      return errorResult('INVALID_RESPONSE', 'Bright Data trigger response not JSON');
    }
    snapshotId = startJson && (startJson.snapshot_id || startJson.snapshotId);
    if (!snapshotId || typeof snapshotId !== 'string') {
      return errorResult('INVALID_RESPONSE', 'Bright Data snapshot_id missing');
    }

    const deadline = Date.now() + MAX_WAIT_MS;
    let status = 'starting';
    while (Date.now() < deadline) {
      if (signal && signal.aborted) {
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        throw err;
      }
      await sleep(POLL_INTERVAL_MS, signal);

      const progRes = await withTimeout(
        fetch(API_BASE + '/datasets/v3/progress/' + encodeURIComponent(snapshotId), {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
          signal,
        }),
        DEFAULT_TIMEOUT_MS,
        CODE + '-progress'
      );
      if (!progRes.ok) {
        if (progRes.status === 401 || progRes.status === 403) {
          return errorResult('AUTH_ERROR', 'Bright Data progress auth failed: ' + progRes.status);
        }
        continue;
      }
      let progJson;
      try {
        progJson = await progRes.json();
      } catch (_) {
        continue;
      }
      status = String(progJson.status || status).toLowerCase();
      if (status === 'ready' || status === 'failed' || status === 'canceled' || status === 'cancelled') {
        break;
      }
    }

    if (status === 'failed') {
      return errorResult('PROVIDER_ERROR', 'Bright Data snapshot failed');
    }
    if (status === 'canceled' || status === 'cancelled') {
      return errorResult('CANCELLED', 'Bright Data snapshot canceled');
    }
    if (status !== 'ready') {
      return errorResult('TIMEOUT', 'Bright Data snapshot timed out (status=' + status + ')');
    }

    if (signal && signal.aborted) {
      const err = new Error('cancelled');
      err.code = 'CANCELLED';
      throw err;
    }

    const snapRes = await withTimeout(
      fetch(
        API_BASE +
          '/datasets/v3/snapshot/' +
          encodeURIComponent(snapshotId) +
          '?format=json',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
          signal,
        }
      ),
      Math.max(DEFAULT_TIMEOUT_MS, 60000),
      CODE + '-snapshot'
    );

    if (!snapRes.ok) {
      return errorResult(
        snapRes.status === 401 || snapRes.status === 403 ? 'AUTH_ERROR' : 'HTTP_ERROR',
        'Bright Data snapshot download failed: ' + snapRes.status
      );
    }

    let items;
    try {
      items = await snapRes.json();
    } catch (_) {
      return errorResult('INVALID_RESPONSE', 'Bright Data snapshot not JSON');
    }
    if (!Array.isArray(items)) {
      return errorResult('INVALID_RESPONSE', 'Bright Data snapshot is not an array');
    }

    const results = [];
    for (let i = 0; i < items.length && results.length < limit; i++) {
      const mapped = mapItem(items[i], i);
      if (mapped) results.push(mapped);
    }
    return okResult(results);
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      return errorResult('CANCELLED', 'Bright Data search cancelled');
    }
    if (err && err.code === 'PROVIDER_TIMEOUT') {
      return errorResult('TIMEOUT', err.message || 'Bright Data timeout');
    }
    return errorResult(err.code || 'NETWORK_ERROR', err.message || 'Bright Data failed');
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  mapItem,
  buildInput,
  resolveGeo,
  resolveSignal,
  MAX_RAW,
  DEFAULT_DATASET_ID,
};
