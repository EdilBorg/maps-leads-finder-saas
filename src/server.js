/**
 * Maps Leads Finder SaaS — Application entry point
 *
 * Stage: Prompt 2 — Initial structure and configuration
 *
 * This file boots Express, loads configuration, mounts health routes,
 * serves static frontend assets, and registers centralized error handling.
 *
 * Authentication, sessions (PostgreSQL store), quotas, providers and
 * full business logic are intentionally deferred to later stages.
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const { config, validateConfig } = require('./config/env');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRouter = require('./routes/health');
const { closePool } = require('./db/pool');

// Validate environment early
validateConfig();

const app = express();

// ---------------------------------------------------------------------------
// Security & basic middleware
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false, // Will be tuned when frontend is fully defined
  })
);

app.use(morgan(config.isProduction ? 'combined' : 'dev'));

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------------
// Static frontend (HTML / CSS / JS Vanilla)
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use('/api', healthRouter);

// Placeholder root — will be replaced by proper pages in later stages
app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Maps Leads Finder SaaS</title>
  <link rel="stylesheet" href="/css/main.css">
</head>
<body>
  <main class="wrap">
    <h1>Maps Leads Finder SaaS</h1>
    <p>Estrutura inicial (Prompt 2). Servidor a funcionar.</p>
    <p><a href="/api/health">/api/health</a></p>
  </main>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// 404 + centralized error handler
// ---------------------------------------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = app.listen(config.port, () => {
  console.log(`[server] Maps Leads Finder SaaS listening on port ${config.port}`);
  console.log(`[server] Environment: ${config.nodeEnv}`);
  console.log(`[server] Health: http://localhost:${config.port}/api/health`);
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`[server] Received ${signal}, shutting down...`);
  server.close(async () => {
    try {
      await closePool();
    } catch (err) {
      console.error('[server] Error closing database pool', err);
    }
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    console.error('[server] Forced shutdown');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
