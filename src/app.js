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

  // SPA shell — public/index.html
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // 404 + centralized error handler
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, config };
