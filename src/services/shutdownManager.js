/**
 * Graceful shutdown coordination for recovery job + pool.
 * Pure logic; no Express dependency — unit-testable with injected deps.
 */

/**
 * @param {object} deps
 * @returns {Promise<{ poolClosed: boolean, idle: boolean, alreadyShuttingDown?: boolean }>}
 */
async function performShutdown(deps = {}) {
  const state = deps.state || { shuttingDown: false };
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
    errFn(
      '[server] Recovery job still running after wait; pool not closed to avoid interrupting in-flight work'
    );
    return { poolClosed: false, idle: false };
  }

  if (typeof close === 'function') {
    try {
      await close();
    } catch (err) {
      errFn('[server] Error closing database pool', err);
    }
  }

  return { poolClosed: true, idle: true };
}

module.exports = { performShutdown };
