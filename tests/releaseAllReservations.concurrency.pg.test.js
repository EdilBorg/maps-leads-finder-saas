/**
 * PostgreSQL concurrency: markPendingRemote vs releaseAllReservations under advisory lock.
 * Requires ALLOW_DB_TESTS=1 and a database name ending in _test.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldRunDbIntegration,
  assertSafeTestDatabase,
} = require('./helpers/testDbGuard');

const RUN = typeof shouldRunDbIntegration === 'function'
  ? shouldRunDbIntegration()
  : (process.env.ALLOW_DB_TESTS === '1');

describe('releaseAllReservations concurrency PostgreSQL', { skip: !RUN }, () => {
  let pool;
  let quotaService;

  before(() => {
    if (typeof assertSafeTestDatabase === 'function') assertSafeTestDatabase();
    pool = require('../src/db/pool').getPool();
    quotaService = require('../src/services/quotaService');
  });

  after(async () => {
    if (pool && pool.end) await pool.end().catch(() => {});
  });

  async function createUser() {
    const email = `rel_${Date.now()}_${Math.random().toString(16).slice(2)}@test.local`;
    const { rows } = await pool.query(
      `INSERT INTO users
        (email, email_normalized, password_hash, name, email_verified_at, free_search_used)
       VALUES ($1, $2, 'x', 'Release Concurrency', NOW(), FALSE)
       RETURNING id`,
      [email, email.toLowerCase()]
    );
    return rows[0].id;
  }

  async function createSearch(userId) {
    const { rows } = await pool.query(
      `INSERT INTO searches (user_id, status, query_text, filters)
       VALUES ($1, 'running', 'concurrency test', '{}'::jsonb)
       RETURNING id`,
      [userId]
    );
    return rows[0].id;
  }

  function reserve(periodStart) {
    return {
      periodStart,
      reservedResults: 10,
      reservedCostMicroUsd: 0,
      reservedApiCalls: 1,
    };
  }

  it('release under lock sees active row created by concurrent markPendingRemote', async () => {
    const userId = await createUser();
    const searchId = await createSearch(userId);
    const periodStart = new Date().toISOString();

    // Hold advisory lock briefly in connection A while B tries to release
    const clientA = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientA.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`,
        [String(searchId), 'dataforseo']
      );

      // Insert active pending under A lock
      await clientA.query(
        `INSERT INTO pending_remote_executions (
           user_id, search_id, provider_code, status, external_run_id,
           period_start, reserved_results, reserved_cost_micro_usd, reserved_api_calls
         ) VALUES ($1,$2,'dataforseo','pending','task-concurrent',$3,10,0,1)`,
        [userId, searchId, periodStart]
      );

      // Concurrent release must block until A commits, then hold the reserve
      const releasePromise = quotaService.releaseAllReservations(
        userId,
        searchId,
        [{ code: 'dataforseo', allowed: true, reserve: reserve(periodStart) }],
        { throwOnError: true }
      );

      // Give release time to wait on lock
      await new Promise((r) => setTimeout(r, 50));
      await clientA.query('COMMIT');

      const out = await releasePromise;
      assert.equal(out.ok, true);
      assert.equal(out.results[0].action, 'held_existing_pending_remote');

      const { rows } = await pool.query(
        `SELECT status FROM pending_remote_executions
         WHERE search_id = $1 AND provider_code = 'dataforseo'
           AND status IN ('pending','reconciling','intervention')`,
        [searchId]
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'pending');
    } finally {
      try { await clientA.query('ROLLBACK'); } catch (_) {}
      clientA.release();
    }
  });

  it('force=true closes active pending_remote and does not leave active rows', async () => {
    const userId = await createUser();
    const searchId = await createSearch(userId);
    const periodStart = new Date().toISOString();

    // Seed usage row so release can run
    await pool.query(
      `INSERT INTO provider_usage (user_id, provider_code, period_start, period_end,
         results_reserved, cost_micro_usd_reserved, api_calls_reserved,
         results_used, cost_micro_usd_used, api_calls_used)
       VALUES ($1,'dataforseo',$2,$2,10,0,1,0,0,0)
       ON CONFLICT DO NOTHING`,
      [userId, periodStart]
    ).catch(() => {});

    await pool.query(
      `INSERT INTO pending_remote_executions (
         user_id, search_id, provider_code, status, external_run_id,
         period_start, reserved_results, reserved_cost_micro_usd, reserved_api_calls
       ) VALUES ($1,$2,'dataforseo','pending','task-force',$3,10,0,1)`,
      [userId, searchId, periodStart]
    );

    const out = await quotaService.releaseAllReservations(
      userId,
      searchId,
      [{ code: 'dataforseo', allowed: true, reserve: reserve(periodStart) }],
      { force: true, throwOnError: false }
    );

    assert.equal(out.results[0].action, 'force_released');
    const { rows } = await pool.query(
      `SELECT status FROM pending_remote_executions
       WHERE search_id = $1 AND provider_code = 'dataforseo'`,
      [searchId]
    );
    assert.ok(rows.every((r) => !['pending', 'reconciling', 'intervention'].includes(r.status)));
  });
});
