/**
 * Apify adapter for compass/crawler-google-places (and compatible actors).
 * Default input: searchStringsArray, locationQuery, maxCrawledPlacesPerSearch.
 * Auth via Authorization: Bearer. Starts without waitForFinish; polls; aborts on cancel.
 */
const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'apify';
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = parseInt(process.env.APIFY_MAX_WAIT_MS || '180000', 10) || 180000;
const MAX_RAW = 200;

function isConfigured() {
  return Boolean(
    process.env.APIFY_TOKEN &&
      process.env.APIFY_TOKEN.length > 8 &&
      process.env.APIFY_ACTOR_ID
  );
}

function escapeJsonString(s) {
  return JSON.stringify(String(s)).slice(1, -1);
}

function buildActorInput(criteria) {
  if (process.env.APIFY_INPUT_JSON) {
    const raw = process.env.APIFY_INPUT_JSON
      .replace(/\{\{query\}\}/g, escapeJsonString(criteria.query))
      .replace(/\{\{location\}\}/g, escapeJsonString(criteria.location || ''))
      .replace(/\{\{limit\}\}/g, String(Number(criteria.limit) || 100));
    return JSON.parse(raw);
  }
  const limit = Math.min(Math.max(Number(criteria.limit) || 100, 1), MAX_RAW);
  return {
    searchStringsArray: [String(criteria.query || '').trim()],
    locationQuery: String(criteria.location || '').trim(),
    maxCrawledPlacesPerSearch: limit,
    language: process.env.APIFY_LANGUAGE || 'pt',
    skipClosedPlaces: false,
  };
}

function buildAddress(p) {
  if (p.address && typeof p.address === 'string' && p.address.trim()) {
    return p.address.trim();
  }
  const parts = [p.street, p.city, p.state, p.postalCode || p.zip, p.countryCode || p.country]
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => String(x).trim());
  if (parts.length) return parts.join(', ');
  if (p.fullAddress) return String(p.fullAddress).trim();
  return null;
}

function extractPhotoUrl(p) {
  if (!p || typeof p !== 'object') return null;
  const direct = p.imageUrl || p.photoUrl || p.thumbnailUrl || p.pictureUrl;
  if (direct && typeof direct === 'string' && /^https?:\/\//i.test(direct.trim())) {
    return direct.trim();
  }
  if (Array.isArray(p.imageUrls) && p.imageUrls.length) {
    const u = p.imageUrls.find((x) => typeof x === 'string' && /^https?:\/\//i.test(x));
    if (u) return u.trim();
  }
  if (Array.isArray(p.images) && p.images.length) {
    const first = p.images[0];
    if (typeof first === 'string' && /^https?:\/\//i.test(first)) return first.trim();
    if (first && typeof first.url === 'string' && /^https?:\/\//i.test(first.url)) return first.url.trim();
  }
  if (Array.isArray(p.photos) && p.photos.length) {
    const first = p.photos[0];
    if (typeof first === 'string' && /^https?:\/\//i.test(first)) return first.trim();
    if (first && typeof first.url === 'string' && /^https?:\/\//i.test(first.url)) return first.url.trim();
  }
  return null;
}

function mapItem(p, idx, criteria) {
  const name = p.title || p.name || p.businessName || null;
  if (!name) return null;
  const rating =
    typeof p.totalScore === 'number'
      ? p.totalScore
      : typeof p.rating === 'number'
        ? p.rating
        : typeof p.stars === 'number'
          ? p.stars
          : null;
  const reviewsCount =
    typeof p.reviewsCount === 'number'
      ? p.reviewsCount
      : typeof p.reviews === 'number'
        ? p.reviews
        : null;
  const lat =
    p.location && p.location.lat != null
      ? Number(p.location.lat)
      : p.lat != null
        ? Number(p.lat)
        : p.latitude != null
          ? Number(p.latitude)
          : null;
  const lng =
    p.location && p.location.lng != null
      ? Number(p.location.lng)
      : p.lng != null
        ? Number(p.lng)
        : p.longitude != null
          ? Number(p.longitude)
          : null;
  return {
    name: String(name).trim(),
    address: buildAddress(p),
    phone: p.phone || p.phoneNumber || p.telephone || null,
    email: p.email || null,
    website: p.website || null,
    rating: Number.isFinite(rating) ? rating : null,
    reviewsCount: Number.isFinite(reviewsCount) ? reviewsCount : null,
    category: p.categoryName || p.category || criteria.query,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    photoUrl: extractPhotoUrl(p),
    googleMapsUrl: p.url || p.googleMapsUrl || null,
    sourceProvider: CODE,
    externalId:
      p.placeId != null
        ? String(p.placeId)
        : p.place_id != null
          ? String(p.place_id)
          : p.id != null
            ? String(p.id)
            : 'apify-' + idx,
    raw: {
      url: p.url || p.googleMapsUrl || null,
      googleMapsUrl: p.url || p.googleMapsUrl || null,
      placeId: p.placeId || p.place_id || null,
    },
  };
}

async function sleep(ms, signal) {
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

async function search(criteria, signal) {
  if (!isConfigured()) return notConfigured(CODE);
  const token = process.env.APIFY_TOKEN;
  const actorId = process.env.APIFY_ACTOR_ID;
  const base = (process.env.APIFY_BASE_URL || 'https://api.apify.com/v2').replace(/\/$/, '');
  let runId = null;
  try {
    const input = buildActorInput(criteria);
    const startUrl =
      base + '/acts/' + encodeURIComponent(actorId) + '/runs?waitForFinish=0';
    const startRes = await withTimeout(
      fetch(startUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
        signal,
      }),
      DEFAULT_TIMEOUT_MS,
      signal
    );
    if (!startRes.ok) {
      const body = await startRes.text().catch(() => '');
      return errorResult(CODE, 'HTTP_ERROR', 'Apify start failed: ' + startRes.status, {
        errorStage: 'start',
        httpStatus: startRes.status,
        details: body.slice(0, 300),
      });
    }
    const startJson = await startRes.json();
    runId = startJson.data && startJson.data.id;
    if (!runId) {
      return errorResult(CODE, 'INVALID_RESPONSE', 'Apify run id missing', {
        errorStage: 'start',
      });
    }
    const deadline = Date.now() + MAX_WAIT_MS;
    let status = 'RUNNING';
    while (Date.now() < deadline) {
      if (signal && signal.aborted) {
        try {
          await fetch(base + '/actor-runs/' + runId + '/abort', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token },
          });
        } catch (_) {}
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        throw err;
      }
      await sleep(POLL_INTERVAL_MS, signal);
      const stRes = await withTimeout(
        fetch(base + '/actor-runs/' + runId, {
          headers: { Authorization: 'Bearer ' + token },
          signal,
        }),
        DEFAULT_TIMEOUT_MS,
        signal
      );
      if (!stRes.ok) continue;
      const stJson = await stRes.json();
      status = (stJson.data && stJson.data.status) || status;
      if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
        break;
      }
    }
    if (status !== 'SUCCEEDED') {
      if (status === 'RUNNING') {
        try {
          await fetch(base + '/actor-runs/' + runId + '/abort', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token },
          });
        } catch (_) {}
        return errorResult(CODE, 'TIMEOUT', 'Apify run timed out', { errorStage: 'poll' });
      }
      return errorResult(CODE, 'PROVIDER_ERROR', 'Apify run status: ' + status, {
        errorStage: 'poll',
      });
    }
    const dsRes = await withTimeout(
      fetch(base + '/actor-runs/' + runId + '/dataset/items?clean=true&format=json',
        {
          headers: { Authorization: 'Bearer ' + token },
          signal,
        }),
      DEFAULT_TIMEOUT_MS,
      signal
    );
    if (!dsRes.ok) {
      return errorResult(CODE, 'HTTP_ERROR', 'Apify dataset failed: ' + dsRes.status, {
        errorStage: 'dataset',
        httpStatus: dsRes.status,
      });
    }
    const items = await dsRes.json();
    if (!Array.isArray(items)) {
      return errorResult(CODE, 'INVALID_RESPONSE', 'Apify dataset not an array', {
        errorStage: 'dataset',
      });
    }
    const results = [];
    for (let i = 0; i < items.length && results.length < MAX_RAW; i++) {
      const mapped = mapItem(items[i], i, criteria);
      if (mapped) results.push(mapped);
    }
    return okResult(results, {
      rawCount: Array.isArray(items) ? items.length : results.length,
      apiCalls: 1,
      geocodeCalls: 0,
    });
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      if (runId) {
        try {
          await fetch(
            (process.env.APIFY_BASE_URL || 'https://api.apify.com/v2').replace(/\/$/, '') +
              '/actor-runs/' +
              runId +
              '/abort',
            {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + process.env.APIFY_TOKEN },
            }
          );
        } catch (_) {}
      }
      throw err;
    }
    return errorResult(CODE, 'NETWORK_ERROR', (err && err.message) || 'Apify failed', {
      errorStage: 'request',
    });
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  mapItem,
  buildActorInput,
  extractPhotoUrl,
};
