/**
 * Shared provider contract and helpers.
 * External API names must never leak to the frontend response layer.
 */

const DEFAULT_TIMEOUT_MS = 25000;

/**
 * Race work against a timeout and optionally an external AbortSignal.
 *
 * Preferred form (aborts the underlying HTTP request on timeout):
 *   withTimeout((signal) => fetch(url, { signal }), ms, externalSignalOrLabel)
 *
 * Legacy form (cannot abort an already-started promise):
 *   withTimeout(fetch(url, { signal }), ms, label)
 *
 * Third argument may be a label string or an AbortSignal.
 * Timeout rejection uses code PROVIDER_TIMEOUT; external abort uses CANCELLED.
 */
function withTimeout(promiseOrFactory, ms, labelOrSignal) {
  const timeoutMs = ms || DEFAULT_TIMEOUT_MS;
  let label = 'provider';
  let externalSignal = null;
  if (labelOrSignal && typeof labelOrSignal === 'object' && 'aborted' in labelOrSignal) {
    externalSignal = labelOrSignal;
  } else if (typeof labelOrSignal === 'string') {
    label = labelOrSignal;
  }

  const isFactory = typeof promiseOrFactory === 'function';
  const localController = isFactory ? new AbortController() : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    let onExternalAbort = null;
    let forward = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (externalSignal && onExternalAbort) {
        try { externalSignal.removeEventListener('abort', onExternalAbort); } catch (_) {}
      }
      if (externalSignal && forward) {
        try { externalSignal.removeEventListener('abort', forward); } catch (_) {}
      }
    };

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (localController && !localController.signal.aborted) {
        try { localController.abort(); } catch (_) {}
      }
      reject(err);
    };

    const settleResolve = (v) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };

    const timer = setTimeout(() => {
      const err = new Error(`${label} timeout after ${timeoutMs}ms`);
      err.code = 'PROVIDER_TIMEOUT';
      settleReject(err);
    }, timeoutMs);

    if (externalSignal) {
      onExternalAbort = () => {
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        settleReject(err);
      };
      if (externalSignal.aborted) {
        onExternalAbort();
        return;
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let promise;
    try {
      if (isFactory) {
        // Combine external abort into the signal passed to the factory.
        if (externalSignal) {
          forward = () => {
            if (!localController.signal.aborted) {
              try { localController.abort(); } catch (_) {}
            }
          };
          if (externalSignal.aborted) forward();
          else externalSignal.addEventListener('abort', forward, { once: true });
        }
        promise = promiseOrFactory(localController.signal);
      } else {
        promise = promiseOrFactory;
      }
    } catch (e) {
      settleReject(e);
      return;
    }

    Promise.resolve(promise)
      .then(settleResolve)
      .catch(settleReject);
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
    if (metrics.externalRunId != null) out.metrics.externalRunId = String(metrics.externalRunId);
    if (metrics.runId != null) out.metrics.runId = String(metrics.runId);
    if (metrics.snapshotId != null) out.metrics.snapshotId = String(metrics.snapshotId);
  }
  return out;
}

/**
 * errorResult(code, message)
 * errorResult(code, message, details)
 * errorResult(providerCode, errorCode, message, details) — Apify-style 4-arg
 */
function errorResult(a, b, c, d) {
  let errorCode = 'PROVIDER_ERROR';
  let errorMessage = 'provider error';
  let details = null;

  if (typeof d === 'object' && d !== null) {
    errorCode = b || errorCode;
    errorMessage = c || errorMessage;
    details = d;
  } else if (typeof c === 'object' && c !== null) {
    errorCode = a || errorCode;
    errorMessage = b || errorMessage;
    details = c;
  } else if (c != null && typeof c === 'string') {
    errorCode = a || errorCode;
    errorMessage = c || b || errorMessage;
  } else {
    errorCode = a || errorCode;
    errorMessage = b || errorMessage;
  }

  const out = {
    status: 'error',
    results: [],
    errorCode: String(errorCode),
    errorMessage: String(errorMessage).slice(0, 500),
  };
  if (details && typeof details === 'object') {
    if (details.errorStage) out.errorStage = String(details.errorStage).slice(0, 64);
    if (details.httpStatus != null) out.httpStatus = Number(details.httpStatus) || null;
    if (details.details && typeof details.details === 'string') {
      out.details = String(details.details).slice(0, 300);
    }
    if (details.snapshotId != null) out.snapshotId = String(details.snapshotId).slice(0, 200);
    if (details.metadata && typeof details.metadata === 'object' && !Array.isArray(details.metadata)) {
      const metadata = {};
      if (details.metadata.snapshotId != null) metadata.snapshotId = String(details.metadata.snapshotId).slice(0, 200);
      if (details.metadata.providerCode != null) metadata.providerCode = String(details.metadata.providerCode).slice(0, 64);
      if (details.metadata.recoverable != null) metadata.recoverable = Boolean(details.metadata.recoverable);
      if (Object.keys(metadata).length) out.metadata = metadata;
    }
    if (details.pendingRemote != null) out.pendingRemote = Boolean(details.pendingRemote);
    if (details.externalRunId != null) out.externalRunId = String(details.externalRunId).slice(0, 200);
    if (details.runId != null) out.runId = String(details.runId).slice(0, 200);
  }
  return out;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  withTimeout,
  notConfigured,
  emptyResult,
  okResult,
  errorResult,
};
