/**
 * Shared migration runner: advisory lock + schema_migrations.
 * Used by scripts/migrate.js and tests/helpers/applyMigrationsOnce.js.
 */
const fs = require('fs');
const path = require('path');

/** Stable lock key for migration serialization across processes. */
const MIGRATION_LOCK_KEY = 87231405;

/**
 * Apply pending SQL migrations on an existing client (must stay connected until done).
 * @param {import('pg').PoolClient} client
 * @param {{ log?: (msg: string) => void }} [opts]
 */
async function applyMigrationsWithClient(client, opts = {}) {
  const log = opts.log || (() => {});
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
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
      if (rows.length) {
        log(`[migrate] skip ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      log(`[migrate] apply ${file}`);
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
    log('[migrate] done');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch (_) {}
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ log?: (msg: string) => void }} [opts]
 */
async function applyMigrations(pool, opts = {}) {
  const client = await pool.connect();
  try {
    await applyMigrationsWithClient(client, opts);
  } finally {
    client.release();
  }
}

module.exports = {
  MIGRATION_LOCK_KEY,
  applyMigrations,
  applyMigrationsWithClient,
};
