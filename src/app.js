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
const searchRouter = require('./routes/search');
const adminRouter = require('./routes/admin');
const billingRouter = require('./routes/billing');
const { loginRateKey, clientIp } = require('./middleware/rateLimitKeys');

validateConfig();

function createApp(options = {}) {
  const app = express();

  app.set('trust proxy', config.trustProxyHops > 0 ? config.trustProxyHops : false);

  app.use(
    helmet({
      contentSecurityPolicy: false,
    })
  );

  app.use(morgan(config.isProduction ? 'combined' : 'dev'));

  app.use('/api/billing/webhooks/payzeno', express.raw({ type: 'application/json', limit: '256kb' }), (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.payzenoRawBody = req.body.toString('utf8');
      try { req.body = JSON.parse(req.payzenoRawBody); } catch (_) { req.body = {}; }
    }
    next();
  });
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

  // Test-only diagnostic endpoint. Never exposed in production.
  if (config.nodeEnv === 'test' && process.env.ENABLE_TEST_ROUTES === '1') {
    app.get('/__test/rate-key', (req, res) => {
      res.json({
        ip: clientIp(req),
        rateKey: loginRateKey(req),
      });
    });
  }

  function gateDashboard(req, res, next) {
    if (!req.session || !req.session.userId) {
      return res.redirect(302, '/pages/login.html');
    }
    if (!req.session.emailVerified) {
      return res.redirect(302, '/pages/check-email.html');
    }
    return next();
  }

  app.get('/', gateDashboard, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.get('/index.html', gateDashboard, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: false,
      maxAge: config.isProduction ? '1h' : 0,
    })
  );

  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/searches', searchRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/billing', billingRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
