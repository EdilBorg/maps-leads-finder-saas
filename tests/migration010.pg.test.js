/**
 * PostgreSQL integration tests for migrations/010_allow_cancelled_search_status.sql
 *
 * Requires: ALLOW_DB_TESTS=1 and a safe *_test database (testDbGuard).
 * Without that, the suite is skipped — never mocked as integration success.
 *
 * Destructive probes run inside BEGIN…ROLLBACK so shared test schema is restored.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');

const RUN = shouldRunDbIntegration();
const MIGRATION_010 = path.join(__dirname, '..', 'migrations', '010_allow_cancelled_search_status.sql');

function readMigration010() {
  return fs.readFileSync(MIGRATION_010, 'utf8');
}

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

  async function statusOnlyCheck() {
    const { rows } = await pool.query(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE n.nspname = 'public'
        AND t.relname = 'searches'
        AND c.contype = 'c'
        AND c.conkey IS NOT NULL
        AND c.conkey = ARRAY[
          (SELECT a.attnum FROM pg_attribute a
           WHERE a.attrelid = t.oid AND a.attname = 'status' AND NOT a.attisdropped)
        ]::int2[]
    `);
    return rows;
  }

  async function withRollback(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await fn(client);
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
      client.release();
    }
  }

  async function dropStatusOnlyCheck(client) {
    const { rows } = await client.query(`
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE n.nspname = 'public'
        AND t.relname = 'searches'
        AND c.contype = 'c'
        AND c.conkey IS NOT NULL
        AND c.conkey = ARRAY[
          (SELECT a.attnum FROM pg_attribute a
           WHERE a.attrelid = t.oid AND a.attname = 'status' AND NOT a.attisdropped)
        ]::int2[]
    `);
    for (const r of rows) {
      await client.query(`ALTER TABLE public.searches DROP CONSTRAINT ${quoteIdent(r.conname)}`);
    }
  }

  function quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  it('after full migrate: six valid statuses work and invalid is rejected', async () => {
    const defs = await statusOnlyCheck();
    assert.ok(defs.length >= 1);
    assert.ok(defs.some((d) => /cancelled/i.test(d.def)));

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
    }

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

  it('preserves other CHECK constraints on searches (total_raw >= 0)', async () => {
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

  it('re-running migration 010 is idempotent when six-state rule is installed', async () => {
    const sql = readMigration010();
    const before = await statusOnlyCheck();
    assert.ok(before.length >= 1);
    await pool.query(sql);
    const after = await statusOnlyCheck();
    assert.equal(after.length, before.length);
    assert.ok(after.every((d) => /cancelled/i.test(d.def)));
  });

  it('does not alter existing rows when re-applied', async () => {
    const userId = await createUser();
    const ins = await pool.query(
      `INSERT INTO searches (user_id, query, location, status, total_raw)
       VALUES ($1, 'keep-me', 'loc', 'completed', 3)
       RETURNING id, query, status, total_raw`,
      [userId]
    );
    ownedSearchIds.push(ins.rows[0].id);

    await pool.query(readMigration010());

    const { rows } = await pool.query(
      `SELECT query, status, total_raw FROM searches WHERE id = $1`,
      [ins.rows[0].id]
    );
    assert.equal(rows[0].query, 'keep-me');
    assert.equal(rows[0].status, 'completed');
    assert.equal(Number(rows[0].total_raw), 3);
  });

  it('migrates legacy five-state CHECK to six-state and preserves pre-existing rows', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyCheck(client);
      await client.query(`
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_legacy_chk
          CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed'))
      `);

      // Pre-existing row under legacy rule
      const u = await client.query(
        `INSERT INTO users (email, password_hash, email_verified_at)
         VALUES ($1, 'x', NOW()) RETURNING id`,
        [`m010-legacy-${Date.now()}@example.test`]
      );
      const userId = u.rows[0].id;
      const ins = await client.query(
        `INSERT INTO searches (user_id, query, location, status, total_raw)
         VALUES ($1, 'pre-migration', 'loc', 'completed', 7)
         RETURNING id`,
        [userId]
      );

      await client.query(readMigration010());

      // cancelled now accepted
      await client.query(
        `UPDATE searches SET status = 'cancelled' WHERE id = $1`,
        [ins.rows[0].id]
      );
      const { rows } = await client.query(
        `SELECT query, status, total_raw FROM searches WHERE id = $1`,
        [ins.rows[0].id]
      );
      assert.equal(rows[0].query, 'pre-migration');
      assert.equal(rows[0].status, 'cancelled');
      assert.equal(Number(rows[0].total_raw), 7);

      const defs = await client.query(`
        SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'public' AND t.relname = 'searches' AND c.contype = 'c'
          AND c.conkey = ARRAY[
            (SELECT a.attnum FROM pg_attribute a
             WHERE a.attrelid = t.oid AND a.attname = 'status' AND NOT a.attisdropped)
          ]::int2[]
      `);
      assert.ok(defs.rows.some((r) => /cancelled/i.test(r.def)));
    });
  });

  it('fails when status column has no exclusive CHECK', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyCheck(client);
      await assert.rejects(
        async () => {
          await client.query(readMigration010());
        },
        (err) =>
          err &&
          /migration 010/i.test(String(err.message)) &&
          /no CHECK constraint found/i.test(String(err.message))
      );
    });
  });

  it('fails when status CHECK definition is unexpected', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyCheck(client);
      await client.query(`
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_weird_chk
          CHECK (status IN ('pending', 'weird_only'))
      `);
      await assert.rejects(
        async () => {
          await client.query(readMigration010());
        },
        (err) =>
          err &&
          /migration 010/i.test(String(err.message)) &&
          /not the expected legacy rule/i.test(String(err.message))
      );
    });
  });

  it('preserves non-status CHECKs while replacing status rule (in-transaction)', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyCheck(client);
      await client.query(`
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_legacy_chk
          CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed'))
      `);

      const beforeOthers = await client.query(`
        SELECT COUNT(*)::int AS c
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'public' AND t.relname = 'searches' AND c.contype = 'c'
          AND NOT (
            c.conkey IS NOT NULL AND c.conkey = ARRAY[
              (SELECT a.attnum FROM pg_attribute a
               WHERE a.attrelid = t.oid AND a.attname = 'status' AND NOT a.attisdropped)
            ]::int2[]
          )
      `);

      await client.query(readMigration010());

      const afterOthers = await client.query(`
        SELECT COUNT(*)::int AS c
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'public' AND t.relname = 'searches' AND c.contype = 'c'
          AND NOT (
            c.conkey IS NOT NULL AND c.conkey = ARRAY[
              (SELECT a.attnum FROM pg_attribute a
               WHERE a.attrelid = t.oid AND a.attname = 'status' AND NOT a.attisdropped)
            ]::int2[]
          )
      `);
      assert.equal(afterOthers.rows[0].c, beforeOthers.rows[0].c);

      // total_raw still enforced
      let rejected = false;
      try {
        await client.query(
          `INSERT INTO searches (user_id, query, status, total_raw)
           VALUES (
             (SELECT id FROM users LIMIT 1),
             'x', 'pending', -5
           )`
        );
      } catch (err) {
        rejected = err && (err.code === '23514' || /check|constraint/i.test(String(err.message)));
      }
      // If no user exists in TX, insert one first
      if (!rejected) {
        const u = await client.query(
          `INSERT INTO users (email, password_hash, email_verified_at)
           VALUES ($1, 'x', NOW()) RETURNING id`,
          [`m010-chk-${Date.now()}@example.test`]
        );
        await assert.rejects(
          async () => {
            await client.query(
              `INSERT INTO searches (user_id, query, status, total_raw)
               VALUES ($1, 'x', 'pending', -5)`,
              [u.rows[0].id]
            );
          },
          (err) => err && (err.code === '23514' || /check|constraint/i.test(String(err.message)))
        );
      }
    });
  });
});

/** Static shape checks that always run (no DB). */
describe('migration 010 SQL shape', () => {
  const sql = readMigration010();

  it('uses pg_attribute / conkey for discovery', () => {
    assert.match(sql, /pg_attribute/);
    assert.match(sql, /conkey/);
    assert.match(sql, /attname = 'status'/);
  });

  it('fails closed when no status-only CHECK exists', () => {
    assert.match(sql, /matched_count = 0/);
    assert.match(sql, /refusing to invent one/);
    assert.equal(/ADD CONSTRAINT searches_status_check[\s\S]*matched_count = 0/.test(sql), false);
  });

  it('validates full legacy five-state set before drop', () => {
    assert.match(sql, /literal_count/);
    assert.match(sql, /has_partial/);
    assert.match(sql, /has_failed/);
    assert.match(sql, /not the expected legacy rule/);
  });

  it('targets the six allowed statuses including cancelled', () => {
    assert.match(
      sql,
      /status IN \('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'\)/
    );
  });
});
