/**
 * Apply SQL migrations in order.
 * Usage: node scripts/migrate.js
 */
require('dotenv').config();
const { getPool, closePool } = require('../src/db/pool');
const { applyMigrations } = require('../src/db/migrate');

async function migrate() {
  if (process.env.ALLOW_DB_TESTS === '1') {
    const { assertSafeTestDatabase } = require('../tests/helpers/testDbGuard');
    const name = assertSafeTestDatabase();
    console.log('[migrate] test mode — target database:', name);
  }

  const pool = getPool();
  try {
    await applyMigrations(pool, { log: console.log });
  } finally {
    await closePool();
  }
}

migrate().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
