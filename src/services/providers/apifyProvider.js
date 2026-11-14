/**
 * Apify adapter — input shape is actor-specific and env-configurable.
 * Never log tokens. JSON template substitution escapes string values.
 * Supports AbortSignal and run abort via Apify API.
 */

const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'apify';

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
  const qKey = process.env.APIFY_INPUT_QUERY_KEY || 'search';
  const lKey = process.env.APIFY_INPUT_LOCATION_KEY || 'location';
  const mKey = process.env.APIFY_INPUT_LIMIT_KEY || 'maxItems';
  return {
    [qKey]: criteria.query,
    [lKey]: criteria.location,
    [mKey]: criteria.limit || 100,
  };
}

function mapItem(p, idx, criteria) {
  return {
    name: p.name || p.title || p.businessName || null,
    address: p.address || p.fullAddress || p.street || null,
    phone: p.phone || p.phoneNumber || p.telephone || null,
    email: p.email || null,
    website: p.website || p.url || p.web || null,
    rating: typeof p.rating === 'number' ? p.rating : typeof p.stars === 'number' ? p.stars : null,
    reviewsCount:
      typeof p.reviewsCount === 'number'
        ? p.reviewsCount
        : typeof p.reviews === 'number'
          ? p.reviews
          : null,
    category: p.category || p.categoryName || criteria.query,
    lat: p.lat != null ? Number(p.lat) : p.latitude != null ? Number(p.latitude) : null,
    lng: p.lng != null ? Number(p.lng) : p.longitude != null ? Number(p.longitude) : null,
    sourceProvider: CODE,
    externalId:
      p.id != null
        ? String(p.id)
        : p.placeId != null
          ? String(p.placeId)
          : p.place_id != null
            ? String(p.place_id)
            : `apify-${idx}`,
    raw: {},
  };
}

async function abortRun(runId) {
  if (!runId || !isConfigured()) return false;
  try {
    const token = process.env.APIFY_TOKEN;
    const url = `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}/abort?token=${encodeURIComponent(token)}`;
    await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {object} criteria
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function search(criteria, opts = {}) {
  if (!isConfigured()) return notConfigured(CODE);
  const signal = opts.signal;

  try {
    if (signal && signal.aborted) {
      return errorResult('CANCELLED', 'Apify search cancelled');
    }
    const actorId = process.env.APIFY_ACTOR_ID;
    const token = process.env.APIFY_TOKEN;
    let body;
    try {
      body = buildActorInput(criteria);
    } catch (e) {
      return errorResult('APIFY_INPUT_INVALID', e.message || 'invalid APIFY_INPUT_JSON');
    }

    const startUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(token)}&waitForFinish=120`;
    const startRes = await withTimeout(
      fetch(startUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal,
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), { code: 'HTTP_ERROR', httpStatus: res.status });
        }
        return res.json();
      }),
      Math.max(DEFAULT_TIMEOUT_MS, 130000),
      CODE
    );

    const run = startRes.data || startRes;
    const runId = run.id || run.runId || null;
    if (signal) {
      const onAbort = () => { if (runId) abortRun(runId); };
      if (signal.aborted) {
        if (runId) await abortRun(runId);
        return errorResult('CANCELLED', 'Apify search cancelled');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const status = run.status || run.statusMessage;
    if (status === 'ABORTED' || status === 'TIMED-OUT' || status === 'FAILED') {
      return errorResult('PROVIDER_ERROR', `Apify run ${status}`);
    }

    const datasetId = run.defaultDatasetId || run.datasetId;
    if (!datasetId) {
      const syncUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
      const data = await withTimeout(
        fetch(syncUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }).then(async (res) => {
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), { code: 'HTTP_ERROR' });
          }
          return res.json();
        }),
        Math.max(DEFAULT_TIMEOUT_MS, 90000),
        CODE
      );
      const list = Array.isArray(data) ? data : [];
      return okResult(list.map((p, idx) => mapItem(p, idx, criteria)));
    }

    const itemsUrl = `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(token)}&clean=true&format=json`;
    const data = await withTimeout(
      fetch(itemsUrl, { headers: { Accept: 'application/json' }, signal }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), { code: 'HTTP_ERROR' });
        }
        return res.json();
      }),
      Math.max(DEFAULT_TIMEOUT_MS, 60000),
      CODE
    );

    if (signal && signal.aborted) {
      return errorResult('CANCELLED', 'Apify search cancelled');
    }

    const list = Array.isArray(data) ? data : [];
    return okResult(list.map((p, idx) => mapItem(p, idx, criteria)));
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      return errorResult('CANCELLED', 'Apify search cancelled');
    }
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'apify failed');
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  abortRun,
  buildActorInput,
  escapeJsonString,
  mapItem,
};
