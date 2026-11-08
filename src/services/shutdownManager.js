/**
 * Graceful shutdown coordination for recovery job + pool.
 * Pure logic; no Express dependency — unit-testable with injected deps.
 *
 * State machine (shared `state` object):
 * - shuttingDown: attempt currently in progress (blocks concurrent attempts)
 * - poolClosed: pool was closed successfully (terminal success — only after closePool succeeds)
 *
 * If wait times out, close fails, or closePool is missing, shuttingDown is cleared
 * so a later attempt can retry once dependencies are fixed / the job is idle.
 */

async function performShutdown(deps = {}) {
  const state = deps.state || { shuttingDown: false, poolClosed: false };

  if (state.poolClosed) {
    return { alreadyShuttingDown: true, poolClosed: true, idle: true };
  }

  if (state.shuttingDown) {
    return { alreadyShuttingDown: true, poolClosed: false, idle: false };
  }

  state.shuttingDown = true;

  const logFn = deps.log || console.log;
  const errFn = deps.error || console.error;
  const stopJob = deps.stopAbandonedSearchRecovery;
  const waitIdle = deps.waitForIdle;
  const close = deps.closePool;
  const signal = deps.signal || 'SHUTDOWN';
  const idleMs = deps.idleTimeoutMs != null ? deps.idleTimeoutMs : 7000;

  logFn(`[server] Received ${signal}, shutting down...`);

  if (typeof stopJob === 'function') {
    try {
      stopJob();
    } catch (err) {
      errFn('[server] Error stopping recovery job', err && err.message);
    }
  }

  let idle = false;
  try {
    idle = await waitIdle(idleMs);
  } catch (err) {
    errFn('[server] waitForIdle error', err && err.message);
    idle = false;
  }

  if (!idle) {
    state.shuttingDown = false;
    errFn(
      '[server] Recovery job still running after wait; pool not closed to avoid interrupting in-flight work'
    );
    return { poolClosed: false, idle: false, retryable: true };
  }

  if (typeof close !== 'function') {
    state.shuttingDown = false;
    errFn(
      '[server] closePool is missing or not a function; pool was not closed'
    );
    return {
      poolClosed: false,
      idle: true,
      closeError: true,
      retryable: true,
      reason: 'CLOSE_POOL_MISSING',
    };
  }

  try {
    await close();
    state.poolClosed = true;
    return { poolClosed: true, idle: true };
  } catch (err) {
    state.shuttingDown = false;
    errFn('[server] Error closing database pool', err);
    return { poolClosed: false, idle: true, closeError: true, retryable: true };
  }
}

module.exports = { performShutdown };
