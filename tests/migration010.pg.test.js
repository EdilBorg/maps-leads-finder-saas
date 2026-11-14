/**
 * PostgreSQL integration tests for migrations/010_allow_cancelled_search_status.sql
 *
 * Requires: ALLOW_DB_TESTS=1 and a safe *_test database (testDbGuard).
 * Without that, the suite is skipped — never mocked as integration success.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');

const RUN = shouldRunDbIntegration();
const MIGRATION_010 = path.join(__dirname, '..', 'migrations', '010_allow_cancelled_search_status.sql');

describe('migration 010 searches.status cancelled (pg)', { skip: !RUN }, () => {
  let pool;
  /** @type {string[]} */
  const ownedUserIds = [];
  /** @type {string[]} */
  const ownedSearchIds = [];

  before(async () => {
    assertSafeTestDatabase();
    const { applyMigrationsOnce } = require('./helpers/applyMigrationsOnce');
    const { getPool } = require('../src/db/pool');
    pool = getPool();
    await applyMigrationsOnce(pool);
  });

  after(async () => {
    if (!pool) return;
    const errors = [];
    if (ownedSearchIds.length) {
      try {
        await pool.query(`DELETE FROM searches WHERE id = ANY($1::uuid[])`, [ownedSearchIds]);
      } catch (e) {
        errors.push(e);
      }
    }
    if (ownedUserIds.length) {
      try {
        await pool.query(`DELETE FROM searches WHERE user_id = ANY($1::uuid[])`, [ownedUserIds]);
      } catch (e) {
        errors.push(e);
      }
      try {
        await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ownedUserIds]);
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length) {
      throw new Error(
        'migration010.pg cleanup failed: ' + errors.map((e) => e.message || String(e)).join('; ')
      );
    }
  });

  async function createUser() {
    const email = `m010-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'x', NOW()) RETURNING id`,
      [email]
    );
    ownedUserIds.push(rows[0].id);
    return rows[0].id;
  }

  async function statusCheckDefs() {
    const { rows } = await pool.query(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
      WHERE n.nspname = 'public'
        AND t.relname = 'searches'
        AND c.contype = 'c'
        AND a.attname = 'status'
        AND NOT a.attisdropped
        AND c.conkey = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = t.oid AND attname = 'status' AND NOT attisdropped)
        ]::int2[]
    `);
    return rows;
  }

  async function otherSearchCheckCount() {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS c
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE n.nspname = 'public'
        AND t.relname = 'searches'
        AND c.contype = 'c'
        AND (
          c.conkey IS NULL
          OR NOT (
            c.conkey = ARRAY[
              (SELECT attnum FROM pg_attribute a
               WHERE a.attrelid = t.oid AND a.attname = 'status' AND NOT a.attisdropped)
            ]::int2[]
          )
        )
    `);
    return rows[0].c;
  }

  it('status CHECK allows the six valid states after migration', async () => {
    const defs = await statusCheckDefs();
    assert.ok(defs.length >= 1, 'expected a status CHECK constraint');
    assert.ok(
      defs.some((d) => /cancelled/i.test(d.def)),
      'status CHECK should allow cancelled'
    );

    const userId = await createUser();
    const states = ['pending', 'running', 'completed', 'partial', 'failed', 'cancelled'];
    for (const st of states) {
      const ins = await pool.query(
        `INSERT INTO searches (user_id, query, location, status)
         VALUES ($1, 'q', 'loc', $2) RETURNING id, status`,
        [userId, st]
      );
      ownedSearchIds.push(ins.rows[0].id);
      assert.equal(ins.rows[0].status, st);

      await pool.query(`UPDATE searches SET status = $2 WHERE id = $1`, [ins.rows[0].id, st]);
    }
  });

  it('rejects an invalid status value', async () => {
    const userId = await createUser();
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO searches (user_id, query, location, status)
           VALUES ($1, 'q', 'loc', 'bogus_state')`,
          [userId]
        );
      },
      (err) => err && (err.code === '23514' || /check|constraint/i.test(String(err.message)))
    );
  });

  it('re-running migration 010 is idempotent', async () => {
    const sql = fs.readFileSync(MIGRATION_010, 'utf8');
    const before = await statusCheckDefs();
    assert.ok(before.length >= 1);

    // Execute SQL body again (outside schema_migrations) — must not error or duplicate
    await pool.query(sql);

    const after = await statusCheckDefs();
    assert.equal(after.length, before.length);
    assert.ok(after.every((d) => /cancelled/i.test(d.def)));
  });

  it('preserves other CHECK constraints on searches', async () => {
    // total_raw >= 0 and similar from 003 must still exist
    const count = await otherSearchCheckCount();
    assert.ok(
      count >= 1,
      'expected non-status CHECK constraints on searches (e.g. total_raw >= 0) to remain'
    );

    const userId = await createUser();
    await assert.rejects(
      async () => {
        await pool.query(
          `INSERT INTO searches (user_id, query, location, status, total_raw)
           VALUES ($1, 'q', 'loc', 'pending', -1)`,
          [userId]
        );
      },
      (err) => err && (err.code === '23514' || /check|constraint/i.test(String(err.message)))
    );
  });

  it('does not alter existing search rows when re-applied', async () => {
    const userId = await createUser();
    const ins = await pool.query(
      `INSERT INTO searches (user_id, query, location, status, total_raw)
       VALUES ($1, 'keep-me', 'loc', 'completed', 3)
       RETURNING id, query, status, total_raw`,
      [userId]
    );
    ownedSearchIds.push(ins.rows[0].id);

    const sql = fs.readFileSync(MIGRATION_010, 'utf8');
    await pool.query(sql);

    const { rows } = await pool.query(
      `SELECT query, status, total_raw FROM searches WHERE id = $1`,
      [ins.rows[0].id]
    );
    assert.equal(rows[0].query, 'keep-me');
    assert.equal(rows[0].status, 'completed');
    assert.equal(Number(rows[0].total_raw), 3);
  });
});

/** Static shape checks that always run (no DB). */
describe('migration 010 SQL shape', () => {
  const sql = fs.readFileSync(MIGRATION_010, 'utf8');

  it('uses pg_attribute / conkey, not free-text status heuristics for discovery', () => {
    assert.match(sql, /pg_attribute/);
    assert.match(sql, /conkey/);
    assert.match(sql, /attname = 'status'/);
    // Must not use the old broad text filter as the discovery mechanism
    assert.equal(/ILIKE '%status%'/.test(sql), false);
    assert.equal(/conname = 'searches_status_check'\s*OR/.test(sql), false);
  });

  it('targets the six allowed statuses including cancelled', () => {
    assert.match(
      sql,
      /status IN \('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'\)/
    );
  });

  it('raises on ambiguous or unexpected structure', () => {
    assert.match(sql, /RAISE EXCEPTION/);
    assert.match(sql, /matched_count > 1/);
  });
});
