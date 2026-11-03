/**
 * PostgreSQL connection pool.
 * Connection settings come only from connectionConfig (env-driven).
 * No credentials are hardcoded.
 */

const { Pool } = require('pg');
const { buildPoolConfig } = require('./connectionConfig');

let pool = null;

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

let checkConnectionImpl = defaultCheckConnection;

async function checkConnection() {
  return checkConnectionImpl();
}

function setCheckConnection(fn) {
  checkConnectionImpl = typeof fn === 'function' ? fn : defaultCheckConnection;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function resetPoolForTests() {
  pool = null;
}

module.exports = {
  getPool,
  checkConnection,
  setCheckConnection,
  closePool,
  resetPoolForTests,
};
