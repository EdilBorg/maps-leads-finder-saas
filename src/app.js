/**
 * Express application factory.
 * Creates and configures the app without binding to a port.
 * Used by server.js (production/dev) and by tests.
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');

const { config, validateConfig } = require('./config/env');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const healthRouter = require('./routes/health');

// Validate environment once when the module is loaded
validateConfig();

function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false, // Tuned later when frontend is fully defined
    })
  );

  app.use(morgan(config.isProduction ? 'combined' : 'dev'));

  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false }));

  // Static frontend (HTML / CSS / JS Vanilla)
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // API routes
  app.use('/api', healthRouter);

  // Placeholder root — replaced by proper pages in later stages
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

  // 404 + centralized error handler
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, config };
