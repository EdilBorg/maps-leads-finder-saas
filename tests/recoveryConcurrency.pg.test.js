/**
 * PostgreSQL integration — recovery concurrency scenarios C, D, E, H.
 *
 * Requires ALLOW_DB_TESTS=1 and a safe *_test database (testDbGuard).
 * Uses real independent connections; no mocks of SQL concurrency.
 *
 * Status when guard fails: entire suite is skipped (not validated).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');

const RUN = shouldRunDbIntegration();

describe('recovery concurrency PostgreSQL (C/D/E/H)', { skip: !RUN }, () => {
  let pool;
  let acquireFreeSearchHold;
  let bindHoldToSearch;
  let renewFreeSearchHold;
  let recoverAbandonedSearches;
  let lockUserForUpdate;
  let runOnce;
  let ADVISORY_KEY;

  before(async () => {
    assertSafeTestDatabase();
    const { getPool } = require('../src/db/pool');
    pool = getPool();
    ({
      acquireFreeSearchHold,
      bindHoldToSearch,
      renewFreeSearchHold,
      recoverAbandonedSearches,
      lockUserForUpdate,
    } = require('../src/services/freeSearchHold'));
    ({ runOnce, ADVISORY_KEY } = require('../src/services/abandonedSearchRecovery'));
  });

  after(async () => {
    if (pool && pool.end) await pool.end().catch(() => {});
  });

  async function createUser() {
    const email = `rcv_${Date.now()}_${Math.random().toString(16).slice(2)}@test.local`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, email_verified, free_search_used)
       VALUES ($1, 'x', 'Recovery Test', TRUE, FALSE)
       RETURNING id`,
      [email]
    );
    return rows[0].id;
  }

  async function cleanupUser(id) {
    await pool.query('DELETE FROM search_results WHERE user_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM searches WHERE user_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }

  it('C: renew under user lock vs recover keeps valid lease and running search', async () => {
    const userId = await createUser();
    let searchId;
    try {
      const setup = await pool.connect();
      try {
        const hold = await acquireFreeSearchHold(setup, userId);
        assert.equal(hold.allowed, true);
        const ins = await setup.query(
          `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
           VALUES ($1, 'c-query', 'loc', $2::jsonb, 'running', '[]'::jsonb,
                   NOW() - interval '2 hours', NOW() + interval '30 days')
           RETURNING id`,
          [userId, JSON.stringify({ holdToken: hold.holdToken })]
        );
        searchId = ins.rows[0].id;
        const bound = await bindHoldToSearch(setup, userId, hold.holdToken, searchId);
        assert.equal(bound, true);
      } finally {
        setup.release();
      }

      const c1 = await pool.connect();
      const c2 = await pool.connect();
      try {
        await c1.query('BEGIN');
        await lockUserForUpdate(c1, userId);

        const recoverPromise = recoverAbandonedSearches(c2, { graceMinutes: 30 });

        await new Promise((r) => setTimeout(r, 50));
        const { rows: tok } = await c1.query(
          'SELECT free_search_hold_token FROM users WHERE id=$1',
          [userId]
        );
        const renewed = await renewFreeSearchHold(c1, userId, tok[0].free_search_hold_token);
        assert.equal(renewed.renewed, true);
        await c1.query('COMMIT');

        const result = await recoverPromise;
        assert.ok(result.abandoned >= 0);

        const { rows: s } = await pool.query('SELECT status FROM searches WHERE id=$1', [searchId]);
        assert.equal(s[0].status, 'running');
        const { rows: u } = await pool.query(
          `SELECT free_search_hold_token IS NOT NULL AS has_token,
                  free_search_hold_until > NOW() AS lease_ok,
                  free_search_used
           FROM users WHERE id=$1`,
          [userId]
        );
        assert.equal(u[0].has_token, true);
        assert.equal(u[0].lease_ok, true);
        assert.equal(u[0].free_search_used, false);
      } finally {
        try { await c1.query('ROLLBACK'); } catch (_) {}
        c1.release();
        c2.release();
      }
    } finally {
      await cleanupUser(userId);
    }
  });

  it('D: persist transaction holding user lock vs recover — no deadlock, search not abandoned', async () => {
    const userId = await createUser();
    let searchId;
    try {
      const setup = await pool.connect();
      try {
        const hold = await acquireFreeSearchHold(setup, userId);
        const ins = await setup.query(
          `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
           VALUES ($1, 'd-query', 'loc', $2::jsonb, 'running', '[]'::jsonb,
                   NOW() - interval '2 hours', NOW() + interval '30 days')
           RETURNING id`,
          [userId, JSON.stringify({ holdToken: hold.holdToken })]
        );
        searchId = ins.rows[0].id;
        await bindHoldToSearch(setup, userId, hold.holdToken, searchId);
      } finally {
        setup.release();
      }

      const c1 = await pool.connect();
      const c2 = await pool.connect();
      try {
        await c1.query('BEGIN');
        await lockUserForUpdate(c1, userId);

        const recoverPromise = recoverAbandonedSearches(c2, { graceMinutes: 30 });

        await new Promise((r) => setTimeout(r, 50));
        await c1.query(
          `UPDATE searches SET total_raw = 1, total_after_filters = 1
           WHERE id = $1 AND user_id = $2`,
          [searchId, userId]
        );
        await c1.query('COMMIT');

        await recoverPromise;

        const { rows: s } = await pool.query(
          'SELECT status, total_raw FROM searches WHERE id=$1',
          [searchId]
        );
        assert.equal(s[0].status, 'running');
        assert.equal(Number(s[0].total_raw), 1);
      } finally {
        try { await c1.query('ROLLBACK'); } catch (_) {}
        c1.release();
        c2.release();
      }
    } finally {
      await cleanupUser(userId);
    }
  });

  it('E: second runOnce skips while first holds advisory lock; lock free after release', async () => {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const lock1 = await c1.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_KEY]);
      assert.equal(lock1.rows[0].ok, true);

      const lock2 = await c2.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_KEY]);
      assert.equal(lock2.rows[0].ok, false);

      const result = await runOnce({
        getPool: () => ({
          connect: async () => pool.connect(),
        }),
        recoverAbandonedSearches: async () => {
          throw new Error('should_not_run_recover_while_lock_held');
        },
      });
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'lock_held');

      await c1.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]);

      const c3 = await pool.connect();
      try {
        const lock3 = await c3.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_KEY]);
        assert.equal(lock3.rows[0].ok, true);
        await c3.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]);
      } finally {
        c3.release();
      }
    } finally {
      try {
        await c1.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]);
      } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('H: second recover on already-failed search is a no-op for that row', async () => {
    const userId = await createUser();
    let searchId;
    try {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE users SET
             free_search_hold_token = gen_random_uuid(),
             free_search_hold_until = NOW() - interval '1 hour',
             free_search_hold_search_id = NULL,
             free_search_used = FALSE
           WHERE id = $1`,
          [userId]
        );
        const { rows: tok } = await client.query(
          'SELECT free_search_hold_token FROM users WHERE id=$1',
          [userId]
        );
        const ins = await client.query(
          `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
           VALUES ($1, 'h-query', 'loc', $2::jsonb, 'running', '[]'::jsonb,
                   NOW() - interval '3 hours', NOW() + interval '30 days')
           RETURNING id`,
          [userId, JSON.stringify({ holdToken: tok[0].free_search_hold_token })]
        );
        searchId = ins.rows[0].id;
      } finally {
        client.release();
      }

      const first = await recoverAbandonedSearches(pool, { graceMinutes: 30 });
      assert.ok(first.abandoned >= 1);

      const { rows: afterFirst } = await pool.query(
        'SELECT status, error_summary FROM searches WHERE id=$1',
        [searchId]
      );
      assert.equal(afterFirst[0].status, 'failed');

      const second = await recoverAbandonedSearches(pool, { graceMinutes: 30 });
      const { rows: afterSecond } = await pool.query(
        'SELECT status FROM searches WHERE id=$1',
        [searchId]
      );
      assert.equal(afterSecond[0].status, 'failed');
      const { rows: still } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM searches
         WHERE id = $1 AND status = 'failed'`,
        [searchId]
      );
      assert.equal(still[0].c, 1);
      assert.ok(second.abandoned >= 0);
    } finally {
      await cleanupUser(userId);
    }
  });
});
