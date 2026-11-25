/**
 * BLOCKER: releaseAllReservations must not free a reserve when pending_remote_executions
 * already has an active row for the same user/search/provider — even if the in-memory
 * provider object has no externalRunId / pendingRemote flags.
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

  const calls = { release: [], releaseGlobal: [] };
  require.cache[pusPath] = {
    id: pusPath, filename: pusPath, loaded: true,
    exports: {
      release: async (args) => { calls.release.push(args); return { ok: true }; },
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

function handlerWithActiveRow(active) {
  return async (sql) => {
    if (/BEGIN|COMMIT|ROLLBACK|pg_advisory/i.test(sql)) return { rows: [] };
    if (/FROM pending_remote_executions/i.test(sql) && /status IN/i.test(sql)) {
      return { rows: active ? [active] : [] };
    }
    if (/INSERT INTO pending_remote_executions/i.test(sql)) {
      return { rows: [{ id: 'new-1', status: 'pending', external_run_id: 'task-x' }] };
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
      // Provider object intentionally lacks externalRunId / pendingRemote / requestSent
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
      reserve,
    }]);
    assert.equal(out.ok, true);
    assert.equal(calls.release.length, 1);
    assert.equal(out.results[0].action, 'released');
  });

  it('force=true still releases even with active pending row', async () => {
    const active = {
      id: 'row-pending',
      status: 'pending',
      external_run_id: 'task-1',
    };
    const { qs, calls } = loadQuota(handlerWithActiveRow(active));
    const out = await qs.releaseAllReservations('user-1', 'search-1', [{
      code: 'dataforseo',
      allowed: true,
      reserve,
    }], { force: true });
    assert.equal(out.ok, true);
    assert.equal(calls.release.length, 1);
    assert.equal(out.results[0].action, 'released');
  });
});

describe('markPendingRemote searchId validation', () => {
  afterEach(clearCaches);

  it('rejects null searchId with PENDING_REMOTE_INVALID_SEARCH_ID', async () => {
    const { qs } = loadQuota(async () => ({ rows: [] }));
    await assert.rejects(
      () => qs.markPendingRemote('u1', null, 'dataforseo', reserve, { externalRunId: 't1' }),
      (err) => err && err.code === 'PENDING_REMOTE_INVALID_SEARCH_ID'
    );
  });

  it('rejects empty searchId', async () => {
    const { qs } = loadQuota(async () => ({ rows: [] }));
    await assert.rejects(
      () => qs.markPendingRemote('u1', '  ', 'dataforseo', reserve, { externalRunId: 't1' }),
      (err) => err && err.code === 'PENDING_REMOTE_INVALID_SEARCH_ID'
    );
  });
});
