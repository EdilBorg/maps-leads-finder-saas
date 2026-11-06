/**
 * Apply SQL migrations once per database, serialized with a session advisory lock.
 * Mirrors scripts/migrate.js (schema_migrations) so parallel test files do not race DDL.
 */
const fs = require('fs');
const path = require('path');

const LOCK_KEY = 87231405; // arbitrary stable int for pg_advisory_lock

/**
 * @param {import('pg').Pool} pool
 */
async function applyMigrationsOnce(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const dir = path.join(__dirname, '..', '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
      if (rows.length) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
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
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch (_) {}
    client.release();
  }
}

module.exports = { applyMigrationsOnce };
