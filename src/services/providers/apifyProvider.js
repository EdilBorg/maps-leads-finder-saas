/**
 * Apify adapter — input shape is actor-specific and env-configurable.
 * Never log tokens. JSON template substitution escapes string values.
 * Starts run without waitForFinish so runId is known immediately,
 * then polls until terminal status. AbortSignal triggers real Actor abort.
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
const MAX_WAIT_MS = 120000;

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

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const err = new Error('cancelled');
      err.code = 'CANCELLED';
      reject(err);
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        reject(err);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * @param {object} criteria
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function search(criteria, opts = {}) {
  if (!isConfigured()) return notConfigured(CODE);
  const signal = opts.signal;
  let runId = null;
  let abortListener = null;

  const cleanup = () => {
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
    const token = process.env.APIFY_TOKEN;
    let body;
    try {
      body = buildActorInput(criteria);
    } catch (e) {
      return errorResult('APIFY_INPUT_INVALID', e.message || 'invalid APIFY_INPUT_JSON');
    }

    // Start without waitForFinish so we get runId immediately
    const startUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(token)}`;
    const startRes = await withTimeout(
      fetch(startUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal,
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), {
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

    // Attach abort as soon as we have the runId
    if (signal) {
      abortListener = () => {
        abortRun(runId).catch(() => {});
      };
      if (signal.aborted) {
        await abortRun(runId);
        cleanup();
        return errorResult('CANCELLED', 'Apify search cancelled');
      }
      signal.addEventListener('abort', abortListener, { once: true });
    }

    // Poll until terminal or timeout
    const terminal = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT', 'ABORTING']);
    const startedAt = Date.now();
    let current = run;

    while (!terminal.has(String(current.status || '').toUpperCase())) {
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
      const statusUrl = `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`;
      const statusRes = await withTimeout(
        fetch(statusUrl, { headers: { Accept: 'application/json' }, signal }).then(async (res) => {
          if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), {
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

    const status = String(current.status || '').toUpperCase();
    if (status === 'ABORTED' || status === 'ABORTING') {
      cleanup();
      return errorResult('CANCELLED', 'Apify search cancelled');
    }
    if (status === 'FAILED' || status === 'TIMED-OUT') {
      cleanup();
      return errorResult('PROVIDER_ERROR', `Apify run ${status}`);
    }

    const datasetId = current.defaultDatasetId || current.datasetId;
    if (!datasetId) {
      cleanup();
      return errorResult('PROVIDER_ERROR', 'Apify run finished without dataset');
    }

    if (signal && signal.aborted) {
      cleanup();
      return errorResult('CANCELLED', 'Apify search cancelled');
    }

    const itemsUrl = `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?token=${encodeURIComponent(token)}&clean=true&format=json`;
    const data = await withTimeout(
      fetch(itemsUrl, { headers: { Accept: 'application/json' }, signal }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), {
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

    const list = Array.isArray(data) ? data : [];
    return okResult(list.map((p, idx) => mapItem(p, idx, criteria)));
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
  isConfigured,
  search,
  abortRun,
  buildActorInput,
  escapeJsonString,
  mapItem,
};
