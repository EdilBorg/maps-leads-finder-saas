/**
 * BLOCKER: releaseAllReservations must not free a reserve when pending_remote_executions
 * already has an active row — lock held through financial release; force closes remote row.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

function loadQuota(handler) {
  const qsPath = require.resolve('../src/services/quotaService');
  const poolPath = require.resolve('../src/db/pool');
  const pusPath = require.resolve('../src/services/providerUsageService');
  delete require.cache[qsPath];

  async function query(sql, params) {
    return handler(String(sql), params);
  }

  require.cache[poolPath] = {
    id: poolPath, filename: poolPath, loaded: true,
    exports: {
      getPool: () => ({
        query,
        connect: async () => ({ query, release: () => {} }),
      }),
    },
  };

  const calls = { release: [], releaseGlobal: [], releaseClients: [] };
  require.cache[pusPath] = {
    id: pusPath, filename: pusPath, loaded: true,
    exports: {
      release: async (args) => {
        calls.release.push(args);
        if (args.client) calls.releaseClients.push(true);
        return { ok: true };
      },
      commit: async () => ({ ok: true }),
      releaseGlobalTomTomCalls: async (...a) => { calls.releaseGlobal.push(a); return { ok: true }; },
      reserve: async () => ({ ok: true }),
      reserveGlobalTomTomCalls: async () => ({ ok: true, unlimited: true }),
      commitGlobalTomTomCalls: async () => ({ ok: true }),
    },
  };

  return { qs: require('../src/services/quotaService'), calls };
}

function clearCaches() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('quotaService') || k.includes('db/pool') || k.includes('providerUsageService')) {
      delete require.cache[k];
    }
  }
}

const reserve = {
  periodStart: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  reservedResults: 100,
  reservedCostMicroUsd: 0,
  reservedApiCalls: 1,
};

function handlerWithActiveRow(active, { failRelease = false, trackOrder = null } = {}) {
  return async (sql, params) => {
    if (trackOrder) trackOrder.push(sql.slice(0, 60).replace(/\s+/g, ' '));
    if (/BEGIN|COMMIT|ROLLBACK|pg_advisory/i.test(sql)) return { rows: [] };
    if (/FROM pending_remote_executions/i.test(sql) && /status IN/i.test(sql)) {
      return { rows: active ? [active] : [] };
    }
    if (/UPDATE pending_remote_executions SET/i.test(sql) && /status = 'expired'/i.test(sql)) {
      return { rows: [{ id: active && active.id, status: 'expired' }] };
    }
    if (/INSERT INTO pending_remote_executions/i.test(sql)) {
      return { rows: [{ id: 'new-1', status: 'pending', external_run_id: 'task-x' }] };
    }
    if (failRelease && /provider_usage/i.test(sql)) {
      throw new Error('simulated release failure');
    }
    return { rows: [] };
  };
}

describe('releaseAllReservations DB guard (blocker)', () => {
  afterEach(clearCaches);

  for (const status of ['pending', 'reconciling', 'intervention']) {
    it(`does NOT release when DB has active ${status} and memory has no remote id`, async () => {
      const active = {
        id: `row-${status}`,
        status,
        external_run_id: status === 'intervention' ? null : 'task-remote-1',
        lease_owner: status === 'reconciling' ? 'worker-1' : null,
        lease_expires_at: null,
      };
      const { qs, calls } = loadQuota(handlerWithActiveRow(active));
      const out = await qs.releaseAllReservations('user-1', 'search-1', [{
        code: 'dataforseo',
        allowed: true,
        reserve,
      }]);
      assert.equal(out.ok, true);
      assert.equal(calls.release.length, 0, 'must not call providerUsageService.release');
      assert.equal(out.results[0].action, 'held_existing_pending_remote');
      assert.equal(out.results[0].status, status);
      assert.equal(out.results[0].id, active.id);
    });
  }

  it('releases when no active DB row and no remote signals', async () => {
    const { qs, calls } = loadQuota(handlerWithActiveRow(null));
    const out = await qs.releaseAllReservations('user-1', 'search-1', [{
      code: 'dataforseo',
      allowed: true,
      reserve: {
        ...reserve,
        global: { periodStart: reserve.periodStart, reservedCalls: 1, geo: false },
      },
    }]);
    assert.equal(out.ok, true);
    assert.equal(calls.release.length, 1);
    assert.equal(out.results[0].action, 'released');
    // Both financial releases must share the transaction protected by the advisory lock.
    assert.equal(calls.releaseClients.length, 1);
    assert.ok(calls.release[0].client);
    assert.equal(calls.releaseGlobal.length, 1);
    assert.equal(calls.releaseGlobal[0][2].client, calls.release[0].client);
  });

  it('force=true closes active remote row and releases in same path', async () => {
    const active = {
      id: 'row-pending',
      status: 'pending',
      external_run_id: 'task-1',
    };
    let closed = false;
    const { qs, calls } = loadQuota(async (sql) => {
      if (/BEGIN|COMMIT|ROLLBACK|pg_advisory/i.test(sql)) return { rows: [] };
      if (/FROM pending_remote_executions/i.test(sql) && /FOR UPDATE/i.test(sql)) {
        return { rows: [active] };
      }
      if (/UPDATE pending_remote_executions SET/i.test(sql) && /expired/i.test(sql)) {
        closed = true;
        return { rows: [{ id: active.id, status: 'expired' }] };
      }
      return { rows: [] };
    });
    const out = await qs.releaseAllReservations('user-1', 'search-1', [{
      code: 'dataforseo',
      allowed: true,
      reserve: {
        ...reserve,
        global: { periodStart: reserve.periodStart, reservedCalls: 1, geo: false },
      },
    }], { force: true });
    assert.equal(out.ok, true);
    assert.equal(closed, true, 'must close pending_remote row');
    assert.equal(calls.release.length, 1);
    assert.equal(out.results[0].action, 'force_released');
    assert.equal(out.results[0].closedStatus, 'expired');
    assert.ok(calls.release[0].client);
    assert.equal(calls.releaseGlobal.length, 1);
    assert.equal(calls.releaseGlobal[0][2].client, calls.release[0].client);
  });
});

describe('markPendingRemote searchId validation + lock', () => {
  afterEach(clearCaches);

  it('rejects null searchId with PENDING_REMOTE_INVALID_SEARCH_ID', async () => {
    const { qs } = loadQuota(async () => ({ rows: [] }));
    await assert.rejects(
      () => qs.markPendingRemote('u1', null, 'dataforseo', reserve, { externalRunId: 't1' }),
      (err) => err && err.code === 'PENDING_REMOTE_INVALID_SEARCH_ID'
    );
  });

  it('acquires advisory lock before insert when no external client', async () => {
    const order = [];
    const { qs } = loadQuota(async (sql) => {
      order.push(sql.slice(0, 40).replace(/\s+/g, ' '));
      if (/BEGIN|COMMIT|ROLLBACK|pg_advisory/i.test(sql)) return { rows: [] };
      if (/INSERT INTO pending_remote_executions/i.test(sql)) {
        return { rows: [{ id: 'r1', status: 'pending', external_run_id: 't1' }] };
      }
      return { rows: [] };
    });
    await qs.markPendingRemote('u1', 's1', 'dataforseo', reserve, { externalRunId: 't1' });
    const lockIdx = order.findIndex((s) => /pg_advisory/i.test(s));
    const insertIdx = order.findIndex((s) => /INSERT INTO pending_remote/i.test(s));
    assert.ok(lockIdx >= 0, 'must acquire advisory lock');
    assert.ok(insertIdx > lockIdx, 'insert must happen after lock');
  });
});
