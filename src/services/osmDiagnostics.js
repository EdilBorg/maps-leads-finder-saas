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

const OVERPASS_ALTERNATIVE_URL = 'https://overpass.kumi.systems/api/interpreter';

/** Minimal Overpass QL — low cost, used only to probe reachability. */
const TINY_OVERPASS_QL = '[out:json][timeout:5];node(2105374);out ids;';

function userAgent() {
  return process.env.OSM_USER_AGENT || 'MapsLeadsFinderSaaS/0.1 (contact@example.com)';
}

function primaryOverpassUrl() {
  return process.env.OSM_OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
}

function resolveErrorName(err) {
  if (!err || typeof err !== 'object') return null;
  if (typeof err.name === 'string' && err.name) return err.name.slice(0, 64);
  return null;
}

async function fetchWithTimeout(url, options, timeoutMs = DIAG_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (
      (err && err.name === 'AbortError') ||
      (err && err.code === 'ABORT_ERR') ||
      controller.signal.aborted
    ) {
      const timeoutErr = new Error('diagnostic timeout');
      timeoutErr.code = 'DIAGNOSTIC_TIMEOUT';
      timeoutErr.name = 'TimeoutError';
      throw timeoutErr;
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

  if (code === 'DIAGNOSTIC_TIMEOUT' || (err && err.name === 'TimeoutError')) {
    out.status = 'timeout';
    out.errorCode = 'DIAGNOSTIC_TIMEOUT';
    out.errorName = errorName || 'TimeoutError';
    out.causeCode = causeCode;
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
    const res = await fetchWithTimeout(
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
    let data;
    try {
      data = await res.json();
    } catch {
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

async function probeOverpass(target, url) {
  const t0 = Date.now();
  try {
    const res = await fetchWithTimeout(
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
    let data;
    try {
      data = await res.json();
    } catch {
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
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
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
  results.push(await probeOverpass('overpass_primary', primaryOverpassUrl()));
  results.push(await probeOverpass('overpass_alternative', OVERPASS_ALTERNATIVE_URL));

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
  DIAG_TIMEOUT_MS,
  NOMINATIM_URL,
  OVERPASS_ALTERNATIVE_URL,
  primaryOverpassUrl,
  TINY_OVERPASS_QL,
};
