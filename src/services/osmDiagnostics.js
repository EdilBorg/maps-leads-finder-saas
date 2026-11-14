/**
 * Temporary OSM connectivity diagnostics for production investigation.
 * Does not alter the normal search path. Fixed destinations only (no SSRF).
 */

const {
  resolveErrorCode,
  resolveCauseCode,
} = require('./providers/osmProvider');
const { config } = require('../config/env');

const DIAG_TIMEOUT_MS = 8000;

const NOMINATIM_URL =
  'https://nominatim.openstreetmap.org/search?q=Lisboa%2C%20Portugal&format=json&limit=1';

const OVERPASS_ENDPOINTS = [
  { target: 'vk_maps', url: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter' },
  { target: 'overpass_de', url: 'https://overpass-api.de/api/interpreter' },
  { target: 'overpass_lz4', url: 'https://lz4.overpass-api.de/api/interpreter' },
  { target: 'overpass_private_coffee', url: 'https://overpass.private.coffee/api/interpreter' },
];

/** @deprecated kept for tests that reference the old constant */
const OVERPASS_ALTERNATIVE_URL = OVERPASS_ENDPOINTS[1].url;

/** Minimal Overpass QL — low cost, used only to probe reachability. */
const TINY_OVERPASS_QL = '[out:json][timeout:5];node(2105374);out ids;';

function userAgent() {
  return process.env.OSM_USER_AGENT || 'MapsLeadsFinderSaaS/0.1 (contact@example.com)';
}

function primaryOverpassUrl() {
  return process.env.OSM_OVERPASS_URL || OVERPASS_ENDPOINTS[0].url;
}

function resolveErrorName(err) {
  if (!err || typeof err !== 'object') return null;
  if (typeof err.name === 'string' && err.name) return err.name.slice(0, 64);
  return null;
}

function createTimeoutError() {
  const timeoutErr = new Error('diagnostic timeout');
  timeoutErr.code = 'DIAGNOSTIC_TIMEOUT';
  timeoutErr.name = 'TimeoutError';
  return timeoutErr;
}

function isAbortError(err) {
  return (
    (err && err.name === 'AbortError') ||
    (err && err.code === 'ABORT_ERR') ||
    (err && err.code === 'DIAGNOSTIC_TIMEOUT') ||
    (err && err.name === 'TimeoutError')
  );
}

/**
 * Fetch under a single AbortController deadline covering connection, headers,
 * body download and (when HTTP ok) JSON parsing.
 * Non-OK HTTP responses skip JSON parsing so HTML/text error pages stay http_error.
 * Clears the timer on all completion paths.
 */
async function fetchJsonWithTimeout(url, options, timeoutMs = DIAG_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  function rejectOnAbort() {
    return new Promise((_, reject) => {
      if (controller.signal.aborted) {
        reject(createTimeoutError());
        return;
      }
      const onAbort = () => {
        controller.signal.removeEventListener('abort', onAbort);
        reject(createTimeoutError());
      };
      controller.signal.addEventListener('abort', onAbort);
    });
  }

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });

    if (!res.ok) {
      try {
        await Promise.race([
          res.text().catch(() => ''),
          rejectOnAbort(),
        ]);
      } catch (err) {
        if (timedOut || isAbortError(err) || controller.signal.aborted) {
          throw createTimeoutError();
        }
      }
      return { res, data: null };
    }

    const data = await Promise.race([
      res.json().catch((parseErr) => {
        if (timedOut || controller.signal.aborted || isAbortError(parseErr)) {
          throw createTimeoutError();
        }
        const err = new Error('invalid json');
        err.code = 'INVALID_JSON';
        err.cause = parseErr;
        err.httpStatus = res.status;
        throw err;
      }),
      rejectOnAbort(),
    ]);

    return { res, data };
  } catch (err) {
    if (timedOut || isAbortError(err) || controller.signal.aborted) {
      throw createTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Kept for low-level abort tests of connection phase. */
async function fetchWithTimeout(url, options, timeoutMs = DIAG_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (isAbortError(err) || controller.signal.aborted) {
      throw createTimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function baseResult(target, durationMs) {
  return {
    target,
    status: 'network_error',
    httpStatus: null,
    durationMs,
    errorCode: null,
    errorName: null,
    causeCode: null,
  };
}

function classifyThrown(target, err, durationMs) {
  const out = baseResult(target, durationMs);
  const code = resolveErrorCode(err);
  const causeCode = resolveCauseCode(err);
  const errorName = resolveErrorName(err);

  if (
    code === 'DIAGNOSTIC_TIMEOUT' ||
    (err && err.name === 'TimeoutError') ||
    (err && err.code === 'DIAGNOSTIC_TIMEOUT')
  ) {
    out.status = 'timeout';
    out.errorCode = 'DIAGNOSTIC_TIMEOUT';
    out.errorName = errorName || 'TimeoutError';
    out.causeCode = causeCode;
    return out;
  }

  if (err && err.code === 'INVALID_JSON') {
    out.status = 'invalid_response';
    out.httpStatus = err.httpStatus != null ? err.httpStatus : null;
    out.errorCode = 'INVALID_RESPONSE';
    return out;
  }

  out.status = 'network_error';
  out.errorCode = code;
  out.errorName = errorName;
  out.causeCode = causeCode;
  return out;
}

async function probeNominatim() {
  const target = 'nominatim';
  const t0 = Date.now();
  try {
    const { res, data } = await fetchJsonWithTimeout(
      NOMINATIM_URL,
      {
        method: 'GET',
        headers: {
          'User-Agent': userAgent(),
          Accept: 'application/json',
        },
      },
      DIAG_TIMEOUT_MS
    );

    if (!res.ok) {
      return {
        target,
        status: 'http_error',
        httpStatus: res.status,
        durationMs: Date.now() - t0,
        errorCode: 'HTTP_ERROR',
        errorName: null,
        causeCode: null,
      };
    }

    if (!Array.isArray(data)) {
      return {
        target,
        status: 'invalid_response',
        httpStatus: res.status,
        durationMs: Date.now() - t0,
        errorCode: 'INVALID_RESPONSE',
        errorName: null,
        causeCode: null,
      };
    }

    return {
      target,
      status: 'reachable',
      httpStatus: res.status,
      durationMs: Date.now() - t0,
      errorCode: null,
      errorName: null,
      causeCode: null,
    };
  } catch (err) {
    return classifyThrown(target, err, Date.now() - t0);
  }
}

function isValidOverpassPayload(data) {
  return (
    data != null &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    Array.isArray(data.elements)
  );
}

async function probeOverpass(target, url) {
  const t0 = Date.now();
  try {
    const { res, data } = await fetchJsonWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'User-Agent': userAgent(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(TINY_OVERPASS_QL)}`,
      },
      DIAG_TIMEOUT_MS
    );

    if (!res.ok) {
      return {
        target,
        status: 'http_error',
        httpStatus: res.status,
        durationMs: Date.now() - t0,
        errorCode: 'HTTP_ERROR',
        errorName: null,
        causeCode: null,
      };
    }

    if (!isValidOverpassPayload(data)) {
      return {
        target,
        status: 'invalid_response',
        httpStatus: res.status,
        durationMs: Date.now() - t0,
        errorCode: 'INVALID_RESPONSE',
        errorName: null,
        causeCode: null,
      };
    }

    return {
      target,
      status: 'reachable',
      httpStatus: res.status,
      durationMs: Date.now() - t0,
      errorCode: null,
      errorName: null,
      causeCode: null,
    };
  } catch (err) {
    return classifyThrown(target, err, Date.now() - t0);
  }
}

async function runOsmConnectivityDiagnostic() {
  const results = [];
  results.push(await probeNominatim());

  const custom = process.env.OSM_OVERPASS_URL && String(process.env.OSM_OVERPASS_URL).trim();
  const probed = new Set();
  if (custom) {
    results.push(await probeOverpass('overpass_custom', custom));
    probed.add(custom);
  }

  for (const ep of OVERPASS_ENDPOINTS) {
    if (probed.has(ep.url)) continue;
    results.push(await probeOverpass(ep.target, ep.url));
    probed.add(ep.url);
  }

  return {
    diagnostic: 'osm_connectivity',
    environment: config.nodeEnv || process.env.NODE_ENV || 'unknown',
    timestamp: new Date().toISOString(),
    results,
  };
}

module.exports = {
  runOsmConnectivityDiagnostic,
  probeNominatim,
  probeOverpass,
  fetchWithTimeout,
  fetchJsonWithTimeout,
  DIAG_TIMEOUT_MS,
  NOMINATIM_URL,
  OVERPASS_ALTERNATIVE_URL,
  OVERPASS_ENDPOINTS,
  primaryOverpassUrl,
  TINY_OVERPASS_QL,
  isValidOverpassPayload,
};
