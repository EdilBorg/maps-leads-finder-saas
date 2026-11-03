/**
 * PostgreSQL connection pool.
 * Ready for use; tables and migrations belong to later stages.
 *
 * Connection is configured exclusively via environment variables.
 * No credentials are hardcoded.
 */

const { Pool } = require('pg');
const { config } = require('../config/env');

let pool = null;

/**
 * Build connection configuration from environment.
 */
function buildPoolConfig() {
  if (config.database.url) {
    return {
      connectionString: config.database.url,
      // SSL can be enabled later via env when deploying to managed Postgres
      // ssl: config.isProduction ? { rejectUnauthorized: false } : false,
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

/**
 * Returns a shared Pool instance (lazy initialization).
 */
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
 * Simple health check query.
 * Returns { ok: true, latencyMs } or throws.
 */
async function checkConnection() {
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

/**
 * Graceful shutdown of the pool.
 */
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  checkConnection,
  closePool,
};
