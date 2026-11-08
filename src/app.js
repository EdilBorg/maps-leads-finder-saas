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

  /**
   * Dashboard is only for authenticated + email-verified users.
   * Disable static index auto-serve so / and /index.html are controlled here.
   * Auth pages under /pages/* and CSS/JS remain publicly available.
   */
  function gateDashboard(req, res, next) {
    if (!req.session || !req.session.userId) {
      return res.redirect(302, '/pages/login.html');
    }
    // loadUser refreshes emailVerified from the database on each request.
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
    })
  );

  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/searches', searchRouter);

  if (process.env.ENABLE_TEST_ROUTES === '1' && process.env.NODE_ENV !== 'production') {
    app.get('/__test/client-ip', (req, res) => {
      res.json({ ip: req.ip || null, ips: req.ips || [] });
    });
    app.get('/__test/rate-key', (req, res) => {
      res.json({ ip: clientIp(req), rateKey: loginRateKey(req) });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, config };
