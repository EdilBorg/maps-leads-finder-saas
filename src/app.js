/**
 * Express application factory.
 * Creates and configures the app without binding to a port.
 * Used by server.js (production/dev) and by tests.
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const { config, validateConfig } = require('./config/env');
const { getPool } = require('./db/pool');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { loadUser } = require('./middleware/auth');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');

validateConfig();

/**
 * @param {object} [options]
 * @param {import('express-session').Store} [options.sessionStore] - override for tests
 */
function createApp(options = {}) {
  const app = express();

  // Trust proxy only when TRUST_PROXY_HOPS > 0 (explicit). Default is no trust.
  // Never read X-Forwarded-For manually — clients can spoof it.
  app.set('trust proxy', config.trustProxyHops > 0 ? config.trustProxyHops : false);

  app.use(
    helmet({
      contentSecurityPolicy: false,
    })
  );

  app.use(morgan(config.isProduction ? 'combined' : 'dev'));

  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false }));

  const store =
    options.sessionStore ||
    new pgSession({
      pool: getPool(),
      tableName: config.sessionTable || 'session',
      createTableIfMissing: false,
    });

  app.use(
    session({
      store,
      name: config.sessionCookieName || 'mlf.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: true,
      cookie: {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        maxAge: config.sessionMaxAgeMs,
      },
    })
  );

  app.use(loadUser);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, config };
