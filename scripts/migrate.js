/**
 * Apply SQL migrations in order.
 * Usage: node scripts/migrate.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('../src/db/pool');

async function migrate() {
  // When opting into test mode, refuse to migrate anything except a validated test DB.
  if (process.env.ALLOW_DB_TESTS === '1') {
    const { assertSafeTestDatabase } = require('../tests/helpers/testDbGuard');
    const name = assertSafeTestDatabase();
    console.log('[migrate] test mode — target database:', name);
  }

  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
      if (rows.length) {
        console.log(`[migrate] skip ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`[migrate] apply ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('[migrate] done');
  } finally {
    client.release();
    await closePool();
  }
}

migrate().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
