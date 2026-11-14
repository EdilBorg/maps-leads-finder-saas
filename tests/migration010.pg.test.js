/**
 * PostgreSQL integration tests for migrations/010_allow_cancelled_search_status.sql
 *
 * Requires: ALLOW_DB_TESTS=1 and a safe *_test database (testDbGuard).
 * Without that, the suite is skipped — never mocked as integration success.
 *
 * Destructive probes run inside BEGIN…ROLLBACK so shared test schema is restored.
 * After a rejected migration, the original probe constraint must still be present.
 * Expected migration failures run under SAVEPOINT so the outer TX stays usable.
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

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
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

  async function createUser(client = pool, track = true) {
    const email = `m010-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const emailNormalized = String(email).trim().toLowerCase();
    const { rows } = await client.query(
      `INSERT INTO users (email, email_normalized, password_hash, name, email_verified_at)
       VALUES ($1, $2, 'x', 'Migration 010 Test', NOW()) RETURNING id`,
      [email, emailNormalized]
    );
    if (track) {
      ownedUserIds.push(rows[0].id);
    }
    return rows[0].id;
  }

  async function statusOnlyChecks(client) {
    const q = client || pool;
    const { rows } = await q.query(`
      SELECT c.conname, pg_get_expr(c.conbin, c.conrelid) AS expr
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
      ORDER BY c.conname
    `);
    return rows;
  }

  async function withRollback(fn) {
    const client = await pool.connect();
    let fnError = null;
    try {
      await client.query('BEGIN');
      try {
        await fn(client);
      } catch (err) {
        fnError = err;
      }
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // keep original fnError if present
      }
      client.release();
    }
    if (fnError) throw fnError;
  }

  /**
   * Run fn under a SAVEPOINT so an expected PostgreSQL error does not abort
   * the outer withRollback() transaction (avoids 25P02 on later queries).
   * Always rolls back to the savepoint; returns the original error when fn fails.
   * Throws if fn succeeds unexpectedly.
   */
  async function expectQueryFailure(client, fn) {
    const sp = 'm010_expect_fail';
    await client.query(`SAVEPOINT ${sp}`);
    try {
      await fn();
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      throw new Error('expected operation to fail, but it succeeded');
    } catch (err) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      } catch (_) {}
      try {
        await client.query(`RELEASE SAVEPOINT ${sp}`);
      } catch (_) {}
      if (err && err.message === 'expected operation to fail, but it succeeded') {
        throw err;
      }
      return err;
    }
  }

  async function dropStatusOnlyChecks(client) {
    const rows = await statusOnlyChecks(client);
    for (const r of rows) {
      await client.query(`ALTER TABLE public.searches DROP CONSTRAINT ${quoteIdent(r.conname)}`);
    }
  }

  async function assertConstraintStillNamed(client, name) {
    const { rows } = await client.query(
      `SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON c.conrelid = t.oid
       JOIN pg_namespace n ON t.relnamespace = n.oid
       WHERE n.nspname = 'public' AND t.relname = 'searches' AND c.conname = $1`,
      [name]
    );
    assert.equal(rows.length, 1, `expected constraint ${name} to remain after rejected migration`);
  }

  it('after full migrate: six valid statuses work and invalid is rejected', async () => {
    await withRollback(async (client) => {
      const defs = await statusOnlyChecks(client);
      assert.ok(defs.length >= 1);

      const userId = await createUser(client, false);
      const states = ['pending', 'running', 'completed', 'partial', 'failed', 'cancelled'];
      for (const st of states) {
        const ins = await client.query(
          `INSERT INTO searches (user_id, query, location, status)
           VALUES ($1, 'q', 'loc', $2) RETURNING id, status`,
          [userId, st]
        );
        assert.equal(ins.rows[0].status, st);
      }

      await assert.rejects(
        async () => {
          await client.query(
            `INSERT INTO searches (user_id, query, location, status)
             VALUES ($1, 'q', 'loc', 'bogus_state')`,
            [userId]
          );
        },
        (err) => err && (err.code === '23514' || /check|constraint/i.test(String(err.message)))
      );
    });
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
    const before = await statusOnlyChecks();
    assert.ok(before.length >= 1);
    await pool.query(readMigration010());
    const after = await statusOnlyChecks();
    assert.equal(after.length, before.length);
    assert.deepEqual(
      after.map((r) => r.expr).sort(),
      before.map((r) => r.expr).sort()
    );
  });

  it('does not alter existing rows when re-applied', async () => {
    const userId = await createUser();
    const ins = await pool.query(
      `INSERT INTO searches (user_id, query, location, status, total_raw)
       VALUES ($1, 'keep-me', 'loc', 'completed', 3)
       RETURNING id`,
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

  it('migrates exact legacy five-state CHECK to six-state and preserves rows', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyChecks(client);
      await client.query(`
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_legacy_chk
          CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed'))
      `);

      const legacyEmail = `m010-legacy-${Date.now()}@example.test`;
      const u = await client.query(
        `INSERT INTO users (email, email_normalized, password_hash, name, email_verified_at)
         VALUES ($1, $2, 'x', 'Migration 010 Legacy', NOW()) RETURNING id`,
        [legacyEmail, legacyEmail.trim().toLowerCase()]
      );
      const ins = await client.query(
        `INSERT INTO searches (user_id, query, location, status, total_raw)
         VALUES ($1, 'pre-migration', 'loc', 'completed', 7)
         RETURNING id`,
        [u.rows[0].id]
      );

      await client.query(readMigration010());

      await client.query(`UPDATE searches SET status = 'cancelled' WHERE id = $1`, [ins.rows[0].id]);
      const { rows } = await client.query(
        `SELECT query, status, total_raw FROM searches WHERE id = $1`,
        [ins.rows[0].id]
      );
      assert.equal(rows[0].query, 'pre-migration');
      assert.equal(rows[0].status, 'cancelled');
      assert.equal(Number(rows[0].total_raw), 7);
    });
  });

  it('rejects missing status-only CHECK and does not invent one', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyChecks(client);
      const failErr = await expectQueryFailure(client, async () => {
        await client.query(readMigration010());
      });
      assert.ok(failErr && /no CHECK constraint found/i.test(String(failErr.message)));
      const after = await statusOnlyChecks(client);
      assert.equal(after.length, 0);
    });
  });

  it('rejects legacy-looking CHECK with OR TRUE and leaves it intact', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyChecks(client);
      await client.query(`
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_or_true_chk
          CHECK (
            status IN ('pending', 'running', 'completed', 'partial', 'failed')
            OR TRUE
          )
      `);
      const failErr = await expectQueryFailure(client, async () => {
        await client.query(readMigration010());
      });
      assert.ok(failErr && /does not match the expected/i.test(String(failErr.message)));
      await assertConstraintStillNamed(client, 'searches_status_or_true_chk');
    });
  });

  it('rejects legacy-looking CHECK with extra AND and leaves it intact', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyChecks(client);
      await client.query(`
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_and_extra_chk
          CHECK (
            status IN ('pending', 'running', 'completed', 'partial', 'failed')
            AND status <> 'failed'
          )
      `);
      const failErr = await expectQueryFailure(client, async () => {
        await client.query(readMigration010());
      });
      assert.ok(failErr && /does not match the expected/i.test(String(failErr.message)));
      await assertConstraintStillNamed(client, 'searches_status_and_extra_chk');
    });
  });

  it('rejects six-state CHECK with extra OR allowing other values', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyChecks(client);
      await client.query(`
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_six_or_chk
          CHECK (
            status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled')
            OR status = 'anything_else'
          )
      `);
      const failErr = await expectQueryFailure(client, async () => {
        await client.query(readMigration010());
      });
      assert.ok(failErr && /does not match the expected/i.test(String(failErr.message)));
      await assertConstraintStillNamed(client, 'searches_status_six_or_chk');
    });
  });

  it('rejects six-state CHECK with extra AND that restricts values', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyChecks(client);
      await client.query(`
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_six_and_chk
          CHECK (
            status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled')
            AND status <> 'cancelled'
          )
      `);
      const failErr = await expectQueryFailure(client, async () => {
        await client.query(readMigration010());
      });
      assert.ok(failErr && /does not match the expected/i.test(String(failErr.message)));
      await assertConstraintStillNamed(client, 'searches_status_six_and_chk');
    });
  });

  it('rejects two exclusive status CHECKs as ambiguous', async () => {
    await withRollback(async (client) => {
      await dropStatusOnlyChecks(client);
      await client.query(`
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_a_chk
          CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed'));
        ALTER TABLE public.searches
          ADD CONSTRAINT searches_status_b_chk
          CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'));
      `);
      const failErr = await expectQueryFailure(client, async () => {
        await client.query(readMigration010());
      });
      assert.ok(failErr && /refusing ambiguous/i.test(String(failErr.message)));
      await assertConstraintStillNamed(client, 'searches_status_a_chk');
      await assertConstraintStillNamed(client, 'searches_status_b_chk');
    });
  });
});

/** Static shape checks that always run (no DB). */
describe('migration 010 SQL shape', () => {
  const sql = readMigration010();

  it('uses catalog metadata and pg_get_expr reference comparison', () => {
    assert.match(sql, /pg_attribute/);
    assert.match(sql, /conkey/);
    assert.match(sql, /pg_get_expr\(\s*c\.conbin/);
    assert.match(sql, /_m010_ref_old/);
    assert.match(sql, /_m010_ref_new/);
    assert.match(sql, /IS NOT DISTINCT FROM expected_old/);
    assert.match(sql, /IS NOT DISTINCT FROM expected_new/);
  });

  it('scopes reference CHECK lookups to the session temp schema', () => {
    const hits = sql.match(/n\.oid\s*=\s*pg_my_temp_schema\(\)/g) || [];
    assert.ok(hits.length >= 2, 'expected pg_my_temp_schema() filter on both reference lookups');
  });

  it('fails closed when no status-only CHECK exists', () => {
    assert.match(sql, /matched_count = 0/);
    assert.match(sql, /refusing to invent one/);
  });

  it('does not use literal-count or free-text cancelled detection as the decision', () => {
    assert.equal(/literal_count/.test(sql), false);
    assert.equal(/has_cancelled/.test(sql), false);
    assert.equal(/ILIKE '%cancelled%'/.test(sql), false);
  });

  it('targets the six allowed statuses including cancelled', () => {
    assert.match(
      sql,
      /status IN \('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'\)/
    );
  });
});
