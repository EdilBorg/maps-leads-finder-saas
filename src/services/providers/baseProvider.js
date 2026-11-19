/**
 * Shared provider contract and helpers.
 * External API names must never leak to the frontend response layer.
 */

const DEFAULT_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, label) {
  const timeoutMs = ms || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err = new Error(`${label || 'provider'} timeout after ${timeoutMs}ms`);
      err.code = 'PROVIDER_TIMEOUT';
      reject(err);
    }, timeoutMs);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

function notConfigured(code) {
  return {
    status: 'not_configured',
    results: [],
    errorCode: 'NOT_CONFIGURED',
    errorMessage: `${code} credentials not configured`,
  };
}

function emptyResult() {
  return { status: 'empty', results: [], errorCode: null, errorMessage: null };
}

function okResult(results, metrics) {
  const out = {
    status: results && results.length ? 'ok' : 'empty',
    results: results || [],
    errorCode: null,
    errorMessage: null,
  };
  if (metrics && typeof metrics === 'object') {
    out.metrics = {
      rawCount: metrics.rawCount != null ? Number(metrics.rawCount) : (results ? results.length : 0),
      apiCalls: metrics.apiCalls != null ? Number(metrics.apiCalls) : 0,
      geocodeCalls: metrics.geocodeCalls != null ? Number(metrics.geocodeCalls) : 0,
      pendingRemote: Boolean(metrics.pendingRemote),
    };
  }
  return out;
}

function errorResult(code, message) {
  return {
    status: 'error',
    results: [],
    errorCode: code || 'PROVIDER_ERROR',
    errorMessage: message || 'provider error',
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  withTimeout,
  notConfigured,
  emptyResult,
  okResult,
  errorResult,
};
