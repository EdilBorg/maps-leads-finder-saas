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
    photoUrl: null,
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
      placeId: p.placeId || p.place_id || null,
    },
  };
}

async function abortRun(runId) {
  if (!runId || !isConfigured()) return { ok: false, reason: 'not_configured' };
  try {
    const token = process.env.APIFY_TOKEN;
    const url = 'https://api.apify.com/v2/actor-runs/' + encodeURIComponent(runId) + '/abort';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + token,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: 'http', status: res.status, body: text.slice(0, 120) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'network', message: err && err.message ? err.message : String(err) };
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const err = new Error('cancelled');
      err.code = 'CANCELLED';
      reject(err);
      return;
    }
    let onAbort = null;
    const t = setTimeout(() => {
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch (_) {}
      }
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(t);
        try { signal.removeEventListener('abort', onAbort); } catch (_) {}
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        reject(err);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function authHeaders() {
  return {
    Accept: 'application/json',
    Authorization: 'Bearer ' + process.env.APIFY_TOKEN,
  };
}

async function search(criteria, opts) {
  opts = opts || {};
  if (!isConfigured()) return notConfigured(CODE);
  const signal = opts.signal;
  let runId = null;
  let abortListener = null;

  const cleanup = function () {
    if (signal && abortListener) {
      try { signal.removeEventListener('abort', abortListener); } catch (_) {}
      abortListener = null;
    }
  };

  try {
    if (signal && signal.aborted) {
      return errorResult('CANCELLED', 'Apify search cancelled');
    }

    const actorId = process.env.APIFY_ACTOR_ID;
    let body;
    try {
      body = buildActorInput(criteria);
    } catch (e) {
      return errorResult('APIFY_INPUT_INVALID', e.message || 'invalid APIFY_INPUT_JSON');
    }

    const startUrl = 'https://api.apify.com/v2/acts/' + encodeURIComponent(actorId) + '/runs';
    const startRes = await withTimeout(
      fetch(startUrl, {
        method: 'POST',
        headers: Object.assign({}, authHeaders(), { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: signal,
      }).then(async function (res) {
        if (!res.ok) {
          const text = await res.text().catch(function () { return ''; });
          throw Object.assign(new Error('HTTP ' + res.status + ' ' + text.slice(0, 200)), {
            code: 'HTTP_ERROR',
            httpStatus: res.status,
          });
        }
        return res.json();
      }),
      Math.max(DEFAULT_TIMEOUT_MS, 30000),
      CODE
    );

    const run = startRes.data || startRes;
    runId = run.id || run.runId || null;
    if (!runId) {
      return errorResult('PROVIDER_ERROR', 'Apify did not return a run id');
    }

    if (signal) {
      abortListener = function () {
        abortRun(runId).catch(function () {});
      };
      if (signal.aborted) {
        await abortRun(runId);
        cleanup();
        return errorResult('CANCELLED', 'Apify search cancelled');
      }
      signal.addEventListener('abort', abortListener, { once: true });
    }

    var terminal = { SUCCEEDED: 1, FAILED: 1, ABORTED: 1, 'TIMED-OUT': 1 };
    var startedAt = Date.now();
    var current = run;

    while (!terminal[String(current.status || '').toUpperCase()]) {
      if (signal && signal.aborted) {
        await abortRun(runId);
        cleanup();
        return errorResult('CANCELLED', 'Apify search cancelled');
      }
      if (Date.now() - startedAt > MAX_WAIT_MS) {
        await abortRun(runId);
        cleanup();
        return errorResult('PROVIDER_ERROR', 'Apify run timed out');
      }
      await sleep(POLL_INTERVAL_MS, signal);
      var statusUrl = 'https://api.apify.com/v2/actor-runs/' + encodeURIComponent(runId);
      var statusRes = await withTimeout(
        fetch(statusUrl, { headers: authHeaders(), signal: signal }).then(async function (res) {
          if (!res.ok) {
            var text = await res.text().catch(function () { return ''; });
            throw Object.assign(new Error('HTTP ' + res.status + ' ' + text.slice(0, 200)), {
              code: 'HTTP_ERROR',
              httpStatus: res.status,
            });
          }
          return res.json();
        }),
        Math.max(DEFAULT_TIMEOUT_MS, 15000),
        CODE
      );
      current = statusRes.data || statusRes;
    }

    var status = String(current.status || '').toUpperCase();
    if (status === 'ABORTED') {
      cleanup();
      return errorResult('CANCELLED', 'Apify search cancelled');
    }
    if (status === 'FAILED' || status === 'TIMED-OUT') {
      cleanup();
      return errorResult('PROVIDER_ERROR', 'Apify run ' + status);
    }

    var datasetId = current.defaultDatasetId || current.datasetId;
    if (!datasetId) {
      cleanup();
      return errorResult('PROVIDER_ERROR', 'Apify run finished without dataset');
    }

    if (signal && signal.aborted) {
      cleanup();
      return errorResult('CANCELLED', 'Apify search cancelled');
    }

    var itemsUrl =
      'https://api.apify.com/v2/datasets/' +
      encodeURIComponent(datasetId) +
      '/items?clean=true&format=json';
    var data = await withTimeout(
      fetch(itemsUrl, { headers: authHeaders(), signal: signal }).then(async function (res) {
        if (!res.ok) {
          var text = await res.text().catch(function () { return ''; });
          throw Object.assign(new Error('HTTP ' + res.status + ' ' + text.slice(0, 200)), {
            code: 'HTTP_ERROR',
          });
        }
        return res.json();
      }),
      Math.max(DEFAULT_TIMEOUT_MS, 60000),
      CODE
    );

    cleanup();

    if (signal && signal.aborted) {
      return errorResult('CANCELLED', 'Apify search cancelled');
    }

    var list = Array.isArray(data) ? data : [];
    var mapped = list.map(function (p, idx) { return mapItem(p, idx, criteria); }).filter(Boolean);
    return okResult(mapped.slice(0, MAX_RAW));
  } catch (err) {
    cleanup();
    if (runId && err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      try { await abortRun(runId); } catch (_) {}
    }
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      return errorResult('CANCELLED', 'Apify search cancelled');
    }
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'apify failed');
  }
}

module.exports = {
  code: CODE,
  isConfigured: isConfigured,
  search: search,
  abortRun: abortRun,
  buildActorInput: buildActorInput,
  escapeJsonString: escapeJsonString,
  mapItem: mapItem,
  MAX_RAW: MAX_RAW,
};
