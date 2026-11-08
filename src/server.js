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

const app = createApp();

let server = null;
let shuttingDown = false;

function start() {
  server = app.listen(config.port, () => {
    console.log(`[server] Maps Leads Finder SaaS listening on port ${config.port}`);
    console.log(`[server] Environment: ${config.nodeEnv}`);
    console.log(`[server] Health: http://localhost:${config.port}/api/health`);
  });
  return server;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] Received ${signal}, shutting down...`);

  try {
    stopAbandonedSearchRecovery();
  } catch (err) {
    console.error('[server] Error stopping recovery job', err && err.message);
  }

  const forceTimer = setTimeout(() => {
    console.error('[server] Forced shutdown');
    process.exit(1);
  }, 10000);
  if (typeof forceTimer.unref === 'function') forceTimer.unref();

  const finish = async () => {
    try {
      await waitForIdle(7000);
    } catch (_) {}
    try {
      await closePool();
    } catch (err) {
      console.error('[server] Error closing database pool', err);
    }
    process.exit(0);
  };

  if (!server) {
    await finish();
    return;
  }

  server.close(() => {
    finish();
  });
}

if (require.main === module) {
  start();
  startAbandonedSearchRecovery();
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
}

module.exports = { app, start, shutdown };
