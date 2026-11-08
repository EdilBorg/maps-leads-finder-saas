/**
 * Maps Leads Finder SaaS — Server entry point
 */

const { createApp, config } = require('./app');
const { closePool } = require('./db/pool');
const {
  startAbandonedSearchRecovery,
  stopAbandonedSearchRecovery,
  waitForIdle,
} = require('./services/abandonedSearchRecovery');
const { performShutdown } = require('./services/shutdownManager');

const app = createApp();

let server = null;
const shutdownState = { shuttingDown: false };

function start() {
  server = app.listen(config.port, () => {
    console.log(`[server] Maps Leads Finder SaaS listening on port ${config.port}`);
    console.log(`[server] Environment: ${config.nodeEnv}`);
    console.log(`[server] Health: http://localhost:${config.port}/api/health`);
  });
  return server;
}

async function shutdown(signal, deps = {}) {
  const forceMs = deps.forceTimeoutMs != null ? deps.forceTimeoutMs : 10000;
  const exitFn = deps.exit;

  let forceTimer = null;
  const armForce = require.main === module || typeof exitFn === 'function';
  if (armForce && !shutdownState.shuttingDown) {
    forceTimer = setTimeout(() => {
      (deps.error || console.error)('[server] Forced shutdown');
      if (exitFn) exitFn(1);
      else process.exit(1);
    }, forceMs);
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
  }

  const run = async () => {
    const result = await performShutdown({
      state: shutdownState,
      signal,
      stopAbandonedSearchRecovery: deps.stopAbandonedSearchRecovery || stopAbandonedSearchRecovery,
      waitForIdle: deps.waitForIdle || waitForIdle,
      closePool: deps.closePool || closePool,
      idleTimeoutMs: deps.idleTimeoutMs != null ? deps.idleTimeoutMs : 7000,
      log: deps.log || console.log,
      error: deps.error || console.error,
    });

    if (result.alreadyShuttingDown) return result;

    if (result.poolClosed) {
      if (forceTimer) clearTimeout(forceTimer);
      if (exitFn) exitFn(0);
      else if (require.main === module) process.exit(0);
    }
    return result;
  };

  if (!server || deps.skipServerClose) {
    return run();
  }

  return new Promise((resolve) => {
    server.close(() => {
      run().then(resolve);
    });
  });
}

function _resetShutdownStateForTests() {
  shutdownState.shuttingDown = false;
}

if (require.main === module) {
  start();
  startAbandonedSearchRecovery();
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}

module.exports = { app, start, shutdown, _resetShutdownStateForTests };
