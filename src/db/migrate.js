/**
 * Shared migration runner: advisory lock + schema_migrations.
 * Used by scripts/migrate.js and tests/helpers/applyMigrationsOnce.js.
 */
const fs = require('fs');
const path = require('path');

/** Stable lock key for migration serialization across processes. */
const MIGRATION_LOCK_KEY = 87231405;

/**
 * Release session advisory locks. Returns true only when unlock_all succeeded.
 * @param {import('pg').PoolClient} client
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<boolean>}
 */
async function releaseMigrationLocks(client, opts = {}) {
  const log = opts.log || (() => {});
  try {
    await client.query('SELECT pg_advisory_unlock_all()');
    return true;
  } catch (errAll) {
    log(`[migrate] pg_advisory_unlock_all failed: ${errAll && errAll.message ? errAll.message : errAll}`);
    try {
      const { rows } = await client.query(
        'SELECT pg_advisory_unlock($1) AS unlocked',
        [MIGRATION_LOCK_KEY]
      );
      const unlocked = rows && rows[0] && rows[0].unlocked === true;
      if (!unlocked) {
        log('[migrate] pg_advisory_unlock returned false (lock not held by this session or already free)');
      }
      return false;
    } catch (errOne) {
      log(`[migrate] pg_advisory_unlock failed: ${errOne && errOne.message ? errOne.message : errOne}`);
      return false;
    }
  }
}

/**
 * Apply pending SQL migrations on an existing client (must stay connected until done).
 * @param {import('pg').PoolClient} client
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ lockReleaseOk: boolean }>}
 */
async function applyMigrationsWithClient(client, opts = {}) {
  const log = opts.log || (() => {});
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  let migrationError = null;
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
  } catch (err) {
    migrationError = err;
  }

  const lockReleaseOk = await releaseMigrationLocks(client, opts);

  if (migrationError) {
    const wrapped = migrationError;
    if (!lockReleaseOk) {
      wrapped.lockReleaseFailed = true;
    }
    throw wrapped;
  }

  return { lockReleaseOk };
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ log?: (msg: string) => void }} [opts]
 */
async function applyMigrations(pool, opts = {}) {
  const log = opts.log || (() => {});
  const client = await pool.connect();
  let released = false;
  try {
    const result = await applyMigrationsWithClient(client, opts);
    if (result.lockReleaseOk) {
      client.release();
      released = true;
    } else {
      log('[migrate] destroying client: could not confirm advisory lock release');
      client.release(true);
      released = true;
    }
  } catch (err) {
    if (!released) {
      try {
        if (err && err.lockReleaseFailed) {
          log('[migrate] destroying client after migration error with unlock failure');
          client.release(true);
        } else {
          client.release();
        }
        released = true;
      } catch (releaseErr) {
        log(`[migrate] client release failed: ${releaseErr && releaseErr.message ? releaseErr.message : releaseErr}`);
      }
    }
    throw err;
  }
}

module.exports = {
  MIGRATION_LOCK_KEY,
  applyMigrations,
  applyMigrationsWithClient,
  releaseMigrationLocks,
};
