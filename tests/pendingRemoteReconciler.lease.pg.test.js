const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldRunDbIntegration,
  assertSafeTestDatabase,
} = require('./helpers/testDbGuard');

const RUN = shouldRunDbIntegration();

describe('pending remote lease PostgreSQL', { skip: !RUN }, () => {
  let pool;
  let reconciler;

  before(() => {
    assertSafeTestDatabase();
    pool = require('../src/db/pool').getPool();
    reconciler = require('../src/services/pendingRemoteReconciler');
  });

  after(async () => {
    if (pool) await pool.end().catch(() => {});
  });

  async function createUser() {
    const email = `lease_${Date.now()}_${Math.random().toString(16).slice(2)}@test.local`;
    const { rows } = await pool.query(
      `INSERT INTO users
        (email, email_normalized, password_hash, name, email_verified_at, free_search_used)
       VALUES ($1, $2, 'x', 'Lease Test', NOW(), FALSE)
       RETURNING id`,
      [email, email.toLowerCase()]
    );
    return rows[0].id;
  }

  async function createExecution(userId, owner, leaseMs = 60000) {
    const { rows } = await pool.query(
      `INSERT INTO pending_remote_executions
        (user_id, provider_code, status, external_run_id, period_start,
         reserved_results, reserved_cost_micro_usd, reserved_api_calls,
         lease_owner, lease_expires_at)
       VALUES ($1, 'dataforseo', 'reconciling', 'test-task',
               NOW(), 0, 0, 0, $2,
               clock_timestamp() + ($3 || ' milliseconds')::interval)
       RETURNING *`,
      [userId, owner, String(leaseMs)]
    );
    return rows[0];
  }

  async function cleanupUser(userId) {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  }

  async function getExecution(id) {
    const { rows } = await pool.query(
      `SELECT status, attempts, lease_owner, lease_expires_at,
              actual_results, resolved_at
       FROM pending_remote_executions WHERE id = $1`,
      [id]
    );
    return rows[0];
  }

  async function waitForBlockedQuery(blockerPid, pattern) {
    const deadline = Date.now() + 8000;

    while (Date.now() < deadline) {
      const { rows } = await pool.query(
        `SELECT pid
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> $1
            AND wait_event_type = 'Lock'
            AND query LIKE $2
          LIMIT 1`,
        [blockerPid, pattern]
      );

      if (rows.length) return rows[0].pid;
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    throw new Error(`Query não ficou bloqueada pelo backend ${blockerPid}`);
  }

  async function lockExecution(client, id) {
    const { rows } = await client.query(
      'SELECT pg_backend_pid() AS pid'
    );
    const pid = rows[0].pid;

    await client.query('BEGIN');
    await client.query(
      'SELECT id FROM pending_remote_executions WHERE id = $1 FOR UPDATE',
      [id]
    );
    return pid;
  }

  it('scheduleRetry rejeita execução reclamada por outro worker', async () => {
    const userId = await createUser();

    try {
      const row = await createExecution(userId, 'replacement-worker');

      const result = await reconciler.scheduleRetry(
        { id: row.id, attempts: 0, provider_code: 'dataforseo' },
        'test'
      );

      assert.equal(result, false);

      const current = await getExecution(row.id);
      assert.equal(current.status, 'reconciling');
      assert.equal(current.lease_owner, 'replacement-worker');
      assert.equal(current.attempts, 0);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('scheduleRetry não actualiza depois de a lease expirar durante espera por lock', async () => {
    const userId = await createUser();
    const blocker = await pool.connect();

    try {
      const row = await createExecution(userId, reconciler.workerId, 1000);
      const blockerPid = await lockExecution(blocker, row.id);

      const retryPromise = reconciler.scheduleRetry(
        { id: row.id, attempts: 0, provider_code: 'dataforseo' },
        'expired while waiting'
      );

      await waitForBlockedQuery(
        blockerPid,
        '%UPDATE pending_remote_executions SET%'
      );

      await new Promise(resolve => setTimeout(resolve, 1200));
      await blocker.query('COMMIT');

      const result = await retryPromise;
      assert.equal(result, false);

      const current = await getExecution(row.id);
      assert.equal(current.status, 'reconciling');
      assert.equal(current.lease_owner, reconciler.workerId);
      assert.equal(current.attempts, 0);
    } finally {
      try { await blocker.query('ROLLBACK'); } catch (_) {}
      blocker.release();
      await cleanupUser(userId);
    }
  });

  it('resolveSuccess rejeita execução pertencente a outro worker', async () => {
    const userId = await createUser();

    try {
      const row = await createExecution(userId, 'replacement-worker');

      const result = await reconciler.resolveSuccess(
        { id: row.id, period_start: null },
        { results: 10, apiCalls: 1 }
      );

      assert.deepEqual(result, { ok: false, reason: 'lease_lost' });

      const current = await getExecution(row.id);
      assert.equal(current.status, 'reconciling');
      assert.equal(current.lease_owner, 'replacement-worker');
      assert.equal(current.actual_results, null);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('resolveSuccess rejeita lease expirada durante espera pelo lock', async () => {
    const userId = await createUser();
    const blocker = await pool.connect();

    try {
      const row = await createExecution(userId, reconciler.workerId, 1000);
      const blockerPid = await lockExecution(blocker, row.id);

      const resolvePromise = reconciler.resolveSuccess(
        { id: row.id, period_start: null },
        { results: 10, apiCalls: 1 }
      );

      await waitForBlockedQuery(
        blockerPid,
        '%SELECT id FROM pending_remote_executions%'
      );

      await new Promise(resolve => setTimeout(resolve, 1200));
      await blocker.query('COMMIT');

      const result = await resolvePromise;
      assert.deepEqual(result, { ok: false, reason: 'lease_lost' });

      const current = await getExecution(row.id);
      assert.equal(current.status, 'reconciling');
      assert.equal(current.lease_owner, reconciler.workerId);
      assert.equal(current.actual_results, null);
    } finally {
      try { await blocker.query('ROLLBACK'); } catch (_) {}
      blocker.release();
      await cleanupUser(userId);
    }
  });

  it('resolveSuccess conclui execução com lease válida', async () => {
    const userId = await createUser();

    try {
      const row = await createExecution(userId, reconciler.workerId);

      const result = await reconciler.resolveSuccess(
        { id: row.id, period_start: null },
        { results: 7, apiCalls: 1, costMicroUsd: '0' }
      );

      assert.deepEqual(result, { ok: true });

      const current = await getExecution(row.id);
      assert.equal(current.status, 'resolved');
      assert.equal(current.actual_results, 7);
      assert.ok(current.resolved_at);
      assert.equal(current.lease_owner, null);
    } finally {
      await cleanupUser(userId);
    }
  });

  it('renewLease só renova uma lease ainda válida e pertencente ao worker', async () => {
    const userId = await createUser();

    try {
      const valid = await createExecution(userId, reconciler.workerId);
      assert.equal(await reconciler.renewLease(valid.id), true);

      const replacement = await createExecution(userId, 'replacement-worker');
      assert.equal(await reconciler.renewLease(replacement.id), false);

      const expired = await createExecution(userId, reconciler.workerId, -1000);
      assert.equal(await reconciler.renewLease(expired.id), false);
    } finally {
      await cleanupUser(userId);
    }
  });
});
