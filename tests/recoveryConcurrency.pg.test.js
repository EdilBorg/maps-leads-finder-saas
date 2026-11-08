/**
 * PostgreSQL integration — official scenarios C, D, E, H.
 * Requires ALLOW_DB_TESTS=1 and a safe *_test database (testDbGuard).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');
const { waitUntilBlockedBy, backendPid } = require('./helpers/pgLockWait');

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
  let runAndPersist;

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
    ({ runAndPersist } = require('../src/services/searchService'));
  });

  after(async () => {
    if (pool && pool.end) await pool.end().catch(() => {});
  });

  async function createUser() {
    const email = `rcv_${Date.now()}_${Math.random().toString(16).slice(2)}@test.local`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, email_normalized, password_hash, name, email_verified_at, free_search_used)
       VALUES ($1, $2, 'x', 'Recovery Test', NOW(), FALSE)
       RETURNING id`,
      [email, email.toLowerCase()]
    );
    return rows[0].id;
  }

  async function cleanupUser(id) {
    await pool.query('DELETE FROM search_results WHERE user_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM searches WHERE user_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }

  async function settle(promise) {
    if (!promise) return;
    try { await promise; } catch (_) {}
  }

  it('C [official]: renew × recover — valid lease protects running search', async () => {
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
                   NOW() - interval '2 hours', NOW() + interval '30 days') RETURNING id`,
          [userId, JSON.stringify({ holdToken: hold.holdToken })]
        );
        searchId = ins.rows[0].id;
        assert.equal(await bindHoldToSearch(setup, userId, hold.holdToken, searchId), true);
      } finally { setup.release(); }

      const c1 = await pool.connect();
      const c2 = await pool.connect();
      try {
        const pid1 = await backendPid(c1);
        const pid2 = await backendPid(c2);
        await c1.query('BEGIN');
        await lockUserForUpdate(c1, userId);
        const recoverPromise = recoverAbandonedSearches(c2, { graceMinutes: 30 });
        await waitUntilBlockedBy(pool, pid2, pid1, 8000);
        const { rows: tok } = await c1.query('SELECT free_search_hold_token FROM users WHERE id=$1', [userId]);
        const renewed = await renewFreeSearchHold(c1, userId, tok[0].free_search_hold_token);
        assert.equal(renewed.renewed, true);
        await c1.query('COMMIT');
        await recoverPromise;
        const { rows: s } = await pool.query('SELECT status FROM searches WHERE id=$1', [searchId]);
        assert.equal(s[0].status, 'running');
        const { rows: u } = await pool.query(
          `SELECT free_search_hold_token IS NOT NULL AS has_token,
                  free_search_hold_until > NOW() AS lease_ok, free_search_used FROM users WHERE id=$1`, [userId]
        );
        assert.equal(u[0].has_token, true);
        assert.equal(u[0].lease_ok, true);
        assert.equal(u[0].free_search_used, false);
      } finally {
        try { await c1.query('ROLLBACK'); } catch (_) {}
        c1.release();
        c2.release();
      }
    } finally { await cleanupUser(userId); }
  });

  it('D [official]: runAndPersist × recover — no deadlock; results + quota consistent', async () => {
    const userId = await createUser();
    let cRecover = null;
    const recoverPromiseRef = { p: null };
    try {
      cRecover = await pool.connect();
      const pidRecover = await backendPid(cRecover);
      let blockedOk = false;
      const mockEngine = async () => ({
        searchStatus: 'completed', outcome: 'results',
        results: [{ name: 'Lead D', address: 'Rua 1', phone: null, email: null, website: null,
          rating: 4.5, reviewsCount: 1, category: 'test', lat: null, lng: null,
          sourceProvider: 'test', externalId: 'd-1', raw: {} }],
        totals: { raw: 1, normalized: 1, afterDedup: 1, afterFilters: 1, returned: 1 },
        _providers: ['test'],
      });
      const out = await runAndPersist({
        userId, query: 'd-query', location: 'loc', modality: 'standard', limit: 10,
        executeSearchFn: mockEngine,
        afterUserLock: async ({ client, searchId }) => {
          await client.query(`UPDATE searches SET started_at = NOW() - interval '2 hours' WHERE id = $1`, [searchId]);
          const pidPersist = await backendPid(client);
          recoverPromiseRef.p = recoverAbandonedSearches(cRecover, { graceMinutes: 30 });
          await waitUntilBlockedBy(pool, pidRecover, pidPersist, 8000);
          blockedOk = true;
        },
      });
      assert.equal(blockedOk, true, 'recover must have blocked on persist user lock');
      assert.ok(out.searchId);
      assert.equal(out.totals.results, 1);
      const { rows: s } = await pool.query('SELECT status, total_after_filters FROM searches WHERE id=$1', [out.searchId]);
      assert.notEqual(s[0].status, 'failed');
      assert.equal(Number(s[0].total_after_filters), 1);
      const { rows: results } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM search_results WHERE search_id=$1 AND user_id=$2', [out.searchId, userId]
      );
      assert.equal(results[0].c, 1);
      const { rows: u } = await pool.query('SELECT free_search_used, free_search_hold_token FROM users WHERE id=$1', [userId]);
      assert.equal(u[0].free_search_used, true);
      assert.equal(u[0].free_search_hold_token, null);
    } finally {
      await settle(recoverPromiseRef.p);
      if (cRecover) { try { cRecover.release(); } catch (_) {} }
      await cleanupUser(userId);
    }
  });

  it('D [official] failure path: persist aborts after recover started — await recover, no hang', async () => {
    const userId = await createUser();
    let cRecover = null;
    const recoverPromiseRef = { p: null };
    let blockedOk = false;
    let searchId = null;
    try {
      cRecover = await pool.connect();
      const pidRecover = await backendPid(cRecover);
      await assert.rejects(
        async () => {
          await runAndPersist({
            userId, query: 'd-fail', location: 'loc', modality: 'standard', limit: 10,
            executeSearchFn: async () => ({
              searchStatus: 'completed', outcome: 'results',
              results: [{ name: 'X', address: null, phone: null, email: null, website: null,
                rating: null, reviewsCount: null, category: null, lat: null, lng: null,
                sourceProvider: 'test', externalId: 'df-1', raw: {} }],
              totals: { raw: 1, normalized: 1, afterDedup: 1, afterFilters: 1, returned: 1 },
              _providers: ['test'],
            }),
            afterUserLock: async ({ client, searchId: sid }) => {
              searchId = sid;
              await client.query(`UPDATE searches SET started_at = NOW() - interval '2 hours' WHERE id = $1`, [sid]);
              const pidPersist = await backendPid(client);
              recoverPromiseRef.p = recoverAbandonedSearches(cRecover, { graceMinutes: 30 });
              await waitUntilBlockedBy(pool, pidRecover, pidPersist, 8000);
              blockedOk = true;
              const err = new Error('TEST_PERSIST_ABORT');
              err.code = 'TEST_PERSIST_ABORT';
              throw err;
            },
          });
        },
        (err) => err && err.message === 'TEST_PERSIST_ABORT'
      );
      assert.equal(blockedOk, true);
      assert.ok(searchId);
      await settle(recoverPromiseRef.p);
      const { rows: s } = await pool.query('SELECT status FROM searches WHERE id=$1', [searchId]);
      assert.notEqual(s[0].status, 'completed');
      const { rows: results } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM search_results WHERE search_id=$1', [searchId]
      );
      assert.equal(results[0].c, 0);
    } finally {
      await settle(recoverPromiseRef.p);
      if (cRecover) { try { cRecover.release(); } catch (_) {} }
      await cleanupUser(userId);
    }
  });

  it('E [official]: concurrent runOnce — second skipped while first holds advisory lock', async () => {
    let releaseFirst;
    const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
    let signalEntered;
    const firstEntered = new Promise((resolve) => { signalEntered = resolve; });

    const firstP = runOnce({
      getPool: () => pool,
      recoverAbandonedSearches: async () => {
        signalEntered();
        await holdFirst;
        return { abandoned: 0, holdsReleased: 0 };
      },
    });
    await firstEntered;

    const second = await runOnce({
      getPool: () => pool,
      recoverAbandonedSearches: async () => {
        throw new Error('second job must not run recover while first holds lock');
      },
    });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'lock_held');

    releaseFirst();
    const first = await firstP;
    assert.equal(first.skipped, false);

    const third = await runOnce({
      getPool: () => pool,
      recoverAbandonedSearches: async () => ({ abandoned: 0, holdsReleased: 0 }),
    });
    assert.equal(third.skipped, false);
  });

  it('E [extra]: manual advisory lock causes runOnce skipped', async () => {
    const c1 = await pool.connect();
    try {
      const lock1 = await c1.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_KEY]);
      assert.equal(lock1.rows[0].ok, true);
      const result = await runOnce({
        getPool: () => pool,
        recoverAbandonedSearches: async () => {
          throw new Error('should_not_run_recover_while_lock_held');
        },
      });
      assert.equal(result.skipped, true);
      assert.equal(result.reason, 'lock_held');
      await c1.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]);
      const after = await runOnce({
        getPool: () => pool,
        recoverAbandonedSearches: async () => ({ abandoned: 0, holdsReleased: 0 }),
      });
      assert.equal(after.skipped, false);
    } finally {
      try { await c1.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]); } catch (_) {}
      c1.release();
    }
  });

  it('H [official]: second recover is no-op for already-recovered search', async () => {
    const userId = await createUser();
    let searchId;
    try {
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE users SET free_search_hold_token = gen_random_uuid(),
             free_search_hold_until = NOW() - interval '1 hour',
             free_search_hold_search_id = NULL, free_search_used = FALSE WHERE id = $1`, [userId]
        );
        const { rows: tok } = await client.query('SELECT free_search_hold_token FROM users WHERE id=$1', [userId]);
        const ins = await client.query(
          `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
           VALUES ($1, 'h-query', 'loc', $2::jsonb, 'running', '[]'::jsonb,
                   NOW() - interval '3 hours', NOW() + interval '30 days') RETURNING id`,
          [userId, JSON.stringify({ holdToken: tok[0].free_search_hold_token })]
        );
        searchId = ins.rows[0].id;
      } finally { client.release(); }

      const first = await recoverAbandonedSearches(pool, { graceMinutes: 30 });
      assert.ok(first.abandoned >= 1, 'first recover must abandon at least the target search');

      const snap = async () => {
        const { rows: s } = await pool.query(
          `SELECT id, status, completed_at, error_summary FROM searches WHERE id=$1`, [searchId]
        );
        const { rows: u } = await pool.query(
          `SELECT free_search_used, free_search_hold_token, free_search_hold_until,
                  free_search_hold_search_id FROM users WHERE id=$1`, [userId]
        );
        return {
          id: s[0].id, status: s[0].status,
          completed_at: s[0].completed_at ? new Date(s[0].completed_at).toISOString() : null,
          error_summary: s[0].error_summary,
          free_search_used: u[0].free_search_used,
          free_search_hold_token: u[0].free_search_hold_token,
          free_search_hold_until: u[0].free_search_hold_until
            ? new Date(u[0].free_search_hold_until).toISOString() : null,
          free_search_hold_search_id: u[0].free_search_hold_search_id,
        };
      };

      const before = await snap();
      assert.equal(before.status, 'failed');
      assert.ok(before.completed_at, 'completed_at must be set after recovery');
      assert.ok(
        before.error_summary === 'abandoned' ||
          (before.error_summary && String(before.error_summary).includes('abandon')),
        `expected abandoned error_summary, got ${before.error_summary}`
      );
      assert.equal(before.free_search_used, false);

      const { rows: elig } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM searches WHERE id = $1 AND status = 'running' AND completed_at IS NULL`, [searchId]
      );
      assert.equal(elig[0].c, 0, 'recovered search must not remain eligible');

      await recoverAbandonedSearches(pool, { graceMinutes: 30 });
      const after = await snap();
      assert.equal(after.status, before.status);
      assert.equal(after.completed_at, before.completed_at);
      assert.equal(after.error_summary, before.error_summary);
      assert.equal(after.free_search_used, before.free_search_used);
      assert.equal(after.free_search_hold_token, before.free_search_hold_token);
      assert.equal(after.free_search_hold_until, before.free_search_hold_until);
      assert.equal(after.free_search_hold_search_id, before.free_search_hold_search_id);

      const { rows: elig2 } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM searches WHERE id = $1 AND status = 'running' AND completed_at IS NULL`, [searchId]
      );
      assert.equal(elig2[0].c, 0);
    } finally { await cleanupUser(userId); }
  });
});
