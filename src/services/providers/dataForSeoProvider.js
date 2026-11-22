/**
 * DataForSEO Google Maps SERP API (Standard, normal priority).
 * Docs: https://docs.dataforseo.com/v3/serp/google/maps/
 *
 * Flow: task_post → persist task id → poll task_get/advanced/{id}
 * Billing occurs on task_post only. GET is free.
 * Never re-POST after a successful task creation (idempotency via tag + persisted id).
 */
const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');
const { toIso2Country } = require('./countryCodes');

const CODE = 'dataforseo';
const TASK_POST_URL = 'https://api.dataforseo.com/v3/serp/google/maps/task_post';
const TASK_GET_BASE = 'https://api.dataforseo.com/v3/serp/google/maps/task_get/advanced/';
const ALLOWED_DEPTHS = Object.freeze([100, 200, 300, 400, 500]);
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_MAX_POLL_MS = 180000;
const DEFAULT_LANGUAGE = 'pt';

function isConfigured() {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  return Boolean(
    login && String(login).trim().length > 0 &&
    password && String(password).trim().length > 0
  );
}

function basicAuthHeader() {
  const login = String(process.env.DATAFORSEO_LOGIN || '').trim();
  const password = String(process.env.DATAFORSEO_PASSWORD || '').trim();
  const token = Buffer.from(`${login}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

function resolveSignal(second) {
  if (!second) return undefined;
  if (typeof second.aborted === 'boolean') return second;
  if (second.signal && typeof second.signal.aborted === 'boolean') return second.signal;
  return undefined;
}

function resolveOnRemoteStarted(second) {
  if (!second || typeof second !== 'object') return null;
  return typeof second.onRemoteStarted === 'function' ? second.onRemoteStarted : null;
}

function normalizeDepth(limit) {
  const n = parseInt(limit, 10);
  return ALLOWED_DEPTHS.includes(n) ? n : 100;
}

function buildTaskPayload(criteria) {
  const keyword = String(criteria.query || '').trim();
  const location = String(criteria.location || '').trim();
  const depth = normalizeDepth(criteria.limit);
  const language = process.env.DATAFORSEO_LANGUAGE || DEFAULT_LANGUAGE;
  const country = toIso2Country(criteria.country);

  const task = {
    keyword,
    language_code: language,
    depth,
    priority: 1, // normal
    device: 'desktop',
  };

  // Prefer coordinates when available (lat,lng,zoom)
  const lat = criteria.lat != null ? Number(criteria.lat) : NaN;
  const lng =
    criteria.lng != null ? Number(criteria.lng)
      : criteria.long != null ? Number(criteria.long)
        : NaN;
  if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    task.location_coordinate = `${lat},${lng},14`;
  } else if (location) {
    // location_name: free-form city/region; DataForSEO resolves it
    task.location_name = location;
  }

  // Optional tag for recovery / correlation (max 255)
  if (criteria.searchId) {
    task.tag = String(criteria.searchId).slice(0, 255);
  } else if (criteria.tag) {
    task.tag = String(criteria.tag).slice(0, 255);
  }

  // Country hint via se_domain is not always reliable; location_name already carries locality.
  if (country && !task.location_coordinate) {
    // Keep location_name; country helps disambiguation when location is ambiguous
    if (task.location_name && !task.location_name.toLowerCase().includes(country.toLowerCase())) {
      // leave as-is; DataForSEO uses location_name primarily
    }
  }

  return task;
}

function mapItem(item, idx) {
  if (!item || typeof item !== 'object') return null;
  const title = item.title || item.original_title || null;
  if (!title) return null;

  const ratingObj = item.rating && typeof item.rating === 'object' ? item.rating : null;
  let rating = null;
  if (ratingObj && ratingObj.value != null) {
    const n = Number(ratingObj.value);
    if (Number.isFinite(n)) rating = n;
  }
  const reviewsCount =
    ratingObj && ratingObj.votes_count != null && Number.isFinite(Number(ratingObj.votes_count))
      ? Number(ratingObj.votes_count)
      : null;

  const lat =
    item.latitude != null && Number.isFinite(Number(item.latitude))
      ? Number(item.latitude)
      : null;
  const lng =
    item.longitude != null && Number.isFinite(Number(item.longitude))
      ? Number(item.longitude)
      : null;

  const placeId = item.place_id != null ? String(item.place_id) : null;
  const phone = item.phone != null ? String(item.phone).trim() : null;
  const website =
    (item.url && String(item.url).trim()) ||
    (item.contact_url && String(item.contact_url).trim()) ||
    null;
  const address = item.address != null ? String(item.address).trim() : null;
  const category = item.category != null ? String(item.category).trim() : null;
  const photoUrl = item.main_image != null ? String(item.main_image).trim() : null;
  const googleMapsUrl =
    (item.cid != null && placeId)
      ? `https://www.google.com/maps/place/?q=place_id:${placeId}`
      : null;

  return {
    name: String(title).trim(),
    address,
    phone: phone || null,
    email: null,
    website: website || null,
    rating,
    reviewsCount,
    category: category || null,
    lat,
    lng,
    photoUrl: photoUrl || null,
    googleMapsUrl,
    sourceProvider: CODE,
    externalId: placeId || (item.cid != null ? String(item.cid) : `dfs-${idx}`),
    raw: {
      placeId,
      cid: item.cid != null ? item.cid : null,
      domain: item.domain || null,
      googleMapsUrl,
    },
  };
}

function extractItemsFromTaskResult(taskPayload) {
  const resultArr = Array.isArray(taskPayload.result) ? taskPayload.result : [];
  const items = [];
  for (const block of resultArr) {
    if (!block || !Array.isArray(block.items)) continue;
    for (const it of block.items) {
      if (it && (it.type === 'maps_search' || it.type == null)) {
        items.push(it);
      }
    }
  }
  return items;
}

async function postTask(taskBody, signal) {
  const res = await withTimeout(
    (sig) =>
      fetch(TASK_POST_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify([taskBody]),
        signal: sig,
      }),
    Math.max(DEFAULT_TIMEOUT_MS, 30000),
    signal || CODE + '-post'
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`DataForSEO task_post HTTP ${res.status}`);
    err.code = res.status === 401 || res.status === 403 ? 'AUTH_ERROR' : 'HTTP_ERROR';
    err.httpStatus = res.status;
    err.details = text.slice(0, 300);
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    const err = new Error('DataForSEO task_post response not JSON');
    err.code = 'INVALID_RESPONSE';
    throw err;
  }

  if (data.status_code && data.status_code !== 20000) {
    const err = new Error(data.status_message || 'DataForSEO task_post failed');
    err.code = 'API_ERROR';
    err.httpStatus = data.status_code;
    throw err;
  }

  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const task = tasks[0];
  if (!task) {
    const err = new Error('DataForSEO task_post returned no tasks');
    err.code = 'INVALID_RESPONSE';
    throw err;
  }

  // 20100 = Task Created; other non-success codes
  if (task.status_code && task.status_code !== 20100 && task.status_code !== 20000) {
    const err = new Error(task.status_message || `DataForSEO task status ${task.status_code}`);
    err.code = 'API_ERROR';
    err.httpStatus = task.status_code;
    throw err;
  }

  if (!task.id) {
    const err = new Error('DataForSEO task_post missing task id');
    err.code = 'INVALID_RESPONSE';
    throw err;
  }

  return { taskId: String(task.id), cost: task.cost != null ? Number(task.cost) : null };
}

async function getTaskResult(taskId, signal) {
  const url = TASK_GET_BASE + encodeURIComponent(taskId);
  const res = await withTimeout(
    (sig) =>
      fetch(url, {
        method: 'GET',
        headers: {
          Authorization: basicAuthHeader(),
          Accept: 'application/json',
        },
        signal: sig,
      }),
    Math.max(DEFAULT_TIMEOUT_MS, 30000),
    signal || CODE + '-get'
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`DataForSEO task_get HTTP ${res.status}`);
    err.code = res.status === 401 || res.status === 403 ? 'AUTH_ERROR' : 'HTTP_ERROR';
    err.httpStatus = res.status;
    err.details = text.slice(0, 300);
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    const err = new Error('DataForSEO task_get response not JSON');
    err.code = 'INVALID_RESPONSE';
    throw err;
  }

  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const task = tasks[0];
  if (!task) {
    return { status: 'error', statusCode: data.status_code, message: data.status_message || 'no task' };
  }

  const sc = task.status_code;
  // 20000 = Ok (results ready)
  // 40602 = Task In Queue / not finished
  // 20100 should not appear on GET typically
  if (sc === 40602 || sc === 40601) {
    return { status: 'pending', statusCode: sc, message: task.status_message || 'pending' };
  }
  if (sc === 20000) {
    return { status: 'ready', statusCode: sc, task, items: extractItemsFromTaskResult(task) };
  }
  return {
    status: 'error',
    statusCode: sc,
    message: task.status_message || `status ${sc}`,
  };
}

async function pollUntilReady(taskId, signal, opts = {}) {
  const interval = Number(opts.pollIntervalMs) || Number(process.env.DATAFORSEO_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;
  const maxWait = Number(opts.maxWaitMs) || Number(process.env.DATAFORSEO_MAX_WAIT_MS) || DEFAULT_MAX_POLL_MS;
  const started = Date.now();

  while (Date.now() - started < maxWait) {
    if (signal && signal.aborted) {
      const err = new Error('cancelled');
      err.code = 'CANCELLED';
      throw err;
    }
    const got = await getTaskResult(taskId, signal);
    if (got.status === 'ready') return got;
    if (got.status === 'error') {
      const err = new Error(got.message || 'DataForSEO task failed');
      err.code = 'API_ERROR';
      err.httpStatus = got.statusCode;
      throw err;
    }
    // pending — wait
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  const err = new Error(`DataForSEO poll timeout after ${maxWait}ms`);
  err.code = 'PROVIDER_TIMEOUT';
  // Task was already posted and billed; surface as timeout with task id for recovery
  err.taskId = taskId;
  throw err;
}

/**
 * Main search entry. Supports:
 * - criteria.existingTaskId: skip POST, only poll/get (recovery path)
 * - opts.onRemoteStarted({ externalRunId, providerCode }): called after successful POST
 */
async function search(criteria, signalOrOpts) {
  if (!isConfigured()) return notConfigured(CODE);

  const signal = resolveSignal(signalOrOpts);
  const onRemoteStarted = resolveOnRemoteStarted(signalOrOpts);
  const depth = normalizeDepth(criteria.limit);

  try {
    let taskId = criteria.existingTaskId ? String(criteria.existingTaskId) : null;
    let posted = false;

    if (!taskId) {
      const payload = buildTaskPayload({ ...criteria, limit: depth });
      const post = await postTask(payload, signal);
      taskId = post.taskId;
      posted = true;

      if (onRemoteStarted) {
        try {
          await onRemoteStarted({
            externalRunId: taskId,
            providerCode: CODE,
            runId: taskId,
          });
        } catch (_) {
          // persistence failure must not drop the remote task; continue and return pending metadata
        }
      }
    }

    const ready = await pollUntilReady(taskId, signal);
    const rawItems = Array.isArray(ready.items) ? ready.items : [];
    const leads = [];
    for (let i = 0; i < rawItems.length; i++) {
      const mapped = mapItem(rawItems[i], i);
      if (mapped) leads.push(mapped);
    }

    return okResult(leads, {
      rawCount: rawItems.length,
      apiCalls: posted ? 1 : 0, // billable post only when we submitted
      geocodeCalls: 0,
      externalRunId: taskId,
      runId: taskId,
      pendingRemote: false,
    });
  } catch (err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'AbortError')) {
      return errorResult('CANCELLED', 'DataForSEO search cancelled');
    }
    if (err && err.code === 'PROVIDER_TIMEOUT') {
      // Task may still complete remotely — mark pending so reconciler can fetch later
      return errorResult('TIMEOUT', err.message || 'DataForSEO timeout', {
        errorStage: 'poll',
        metadata: {
          snapshotId: err.taskId || null,
          providerCode: CODE,
          recoverable: true,
        },
        snapshotId: err.taskId || null,
      });
    }
    if (err && err.code === 'AUTH_ERROR') {
      return errorResult('AUTH_ERROR', err.message || 'DataForSEO auth failed', {
        httpStatus: err.httpStatus || 401,
        errorStage: 'auth',
      });
    }
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'dataforseo failed', {
      httpStatus: err.httpStatus || null,
      errorStage: 'search',
    });
  }
}

/**
 * Recovery helper: fetch results for an already-posted task id (no new POST).
 */
async function fetchExistingTask(taskId, signal) {
  if (!isConfigured()) return notConfigured(CODE);
  if (!taskId) {
    return errorResult('VALIDATION', 'taskId required');
  }
  try {
    const ready = await pollUntilReady(String(taskId), signal);
    const rawItems = Array.isArray(ready.items) ? ready.items : [];
    const leads = [];
    for (let i = 0; i < rawItems.length; i++) {
      const mapped = mapItem(rawItems[i], i);
      if (mapped) leads.push(mapped);
    }
    return okResult(leads, {
      rawCount: rawItems.length,
      apiCalls: 0,
      geocodeCalls: 0,
      externalRunId: String(taskId),
      runId: String(taskId),
      pendingRemote: false,
    });
  } catch (err) {
    if (err && err.code === 'PROVIDER_TIMEOUT') {
      return errorResult('TIMEOUT', err.message || 'DataForSEO recovery timeout', {
        errorStage: 'poll',
        metadata: { snapshotId: String(taskId), providerCode: CODE, recoverable: true },
        snapshotId: String(taskId),
      });
    }
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'dataforseo recovery failed', {
      httpStatus: err.httpStatus || null,
      errorStage: 'recovery',
    });
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  fetchExistingTask,
  mapItem,
  buildTaskPayload,
  normalizeDepth,
  ALLOWED_DEPTHS,
  postTask,
  getTaskResult,
};
