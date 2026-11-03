/**
 * Environment configuration and validation.
 */

require('dotenv').config();

const requiredInProduction = ['SESSION_SECRET', 'DATABASE_URL'];

function getEnv(key, fallback = undefined) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return fallback;
  }
  return value;
}

const config = {
  nodeEnv: getEnv('NODE_ENV', 'development'),
  isProduction: getEnv('NODE_ENV') === 'production',
  port: parseInt(getEnv('PORT', '3000'), 10),
  appUrl: getEnv('APP_URL', 'http://localhost:3000'),

  sessionSecret: getEnv('SESSION_SECRET', 'dev-only-change-me-not-for-production'),
  sessionCookieName: getEnv('SESSION_COOKIE_NAME', 'mlf.sid'),
  sessionMaxAgeMs: parseInt(getEnv('SESSION_MAX_AGE_MS', String(7 * 24 * 60 * 60 * 1000)), 10),

  database: {
    url: getEnv('DATABASE_URL'),
    host: getEnv('PGHOST', 'localhost'),
    port: parseInt(getEnv('PGPORT', '5432'), 10),
    user: getEnv('PGUSER', 'postgres'),
    password: getEnv('PGPASSWORD', ''),
    database: getEnv('PGDATABASE', 'maps_leads_finder'),
  },

  sessionTable: getEnv('SESSION_TABLE', 'session'),

  /**
   * Trusted reverse-proxy hops for Express req.ip.
   * Default 0 (do not trust X-Forwarded-For) in all environments unless set.
   * Production must set TRUST_PROXY_HOPS explicitly to match the real proxy chain
   * after validating the host platform (e.g. Abasthan/nginx). Never assume a universal value.
   */
  trustProxyHops: (() => {
    const raw = getEnv('TRUST_PROXY_HOPS');
    if (raw === undefined || raw === '') return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })(),
};

function validateConfig() {
  const missing = [];

  if (config.isProduction) {
    for (const key of requiredInProduction) {
      const value = process.env[key];
      if (!value || value.includes('change_me') || value.includes('colocar_')) {
        missing.push(key);
      }
    }
  }

  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    if (config.isProduction) {
      missing.push('SESSION_SECRET (must be a strong secret, min 16 chars)');
    }
  }

  if (missing.length > 0) {
    const message = `Missing or invalid required environment variables: ${missing.join(', ')}`;
    if (config.isProduction) {
      throw new Error(message);
    }
    console.warn(`[config] WARNING: ${message}`);
  }

  return config;
}

module.exports = {
  config,
  validateConfig,
};
