/**
 * Maps Leads Finder SaaS — Server entry point
 *
 * Starts the HTTP server only when this file is executed directly
 * (node src/server.js / npm start / npm run dev).
 * Tests import createApp from ./app.js and never trigger listen here.
 */

const { createApp, config } = require('./app');
const { closePool } = require('./db/pool');

const app = createApp();

let server = null;

function start() {
  server = app.listen(config.port, () => {
    console.log(`[server] Maps Leads Finder SaaS listening on port ${config.port}`);
    console.log(`[server] Environment: ${config.nodeEnv}`);
    console.log(`[server] Health: http://localhost:${config.port}/api/health`);
  });
  return server;
}

async function shutdown(signal) {
  console.log(`[server] Received ${signal}, shutting down...`);
  if (!server) {
    process.exit(0);
    return;
  }
  server.close(async () => {
    try {
      await closePool();
    } catch (err) {
      console.error('[server] Error closing database pool', err);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[server] Forced shutdown');
    process.exit(1);
  }, 10000).unref();
}

// Only bind to a port when executed as the main module
if (require.main === module) {
  start();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, start, shutdown };
