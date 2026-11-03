/**
 * PostgreSQL connection pool.
 * Ready for use; tables and migrations belong to later stages.
 *
 * Connection is configured exclusively via environment variables.
 * No credentials are hardcoded.
 *
 * checkConnection can be overridden in tests via setCheckConnection()
 * so health tests do not require a live database.
 */

const { Pool } = require('pg');
const { config } = require('../config/env');

let pool = null;

function buildPoolConfig() {
  if (config.database.url) {
    return {
      connectionString: config.database.url,
    };
  }

  return {
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
  };
}

function getPool() {
  if (!pool) {
    const poolConfig = buildPoolConfig();
    pool = new Pool(poolConfig);

    pool.on('error', (err) => {
      console.error('[db] Unexpected error on idle client', err);
    });
  }
  return pool;
}

/**
 * Default health check against the real pool.
 * Returns { ok: true, latencyMs } or throws.
 */
async function defaultCheckConnection() {
  const start = Date.now();
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1 AS ok');
    return {
      ok: true,
      latencyMs: Date.now() - start,
    };
  } finally {
    client.release();
  }
}

/** Active implementation (overridable in tests). */
let checkConnectionImpl = defaultCheckConnection;

/**
 * Public health-check entry point used by routes.
 */
async function checkConnection() {
  return checkConnectionImpl();
}

/**
 * Replace the connection checker (for tests).
 * Pass null/undefined to restore the default implementation.
 */
function setCheckConnection(fn) {
  checkConnectionImpl = typeof fn === 'function' ? fn : defaultCheckConnection;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  checkConnection,
  setCheckConnection,
  closePool,
};
