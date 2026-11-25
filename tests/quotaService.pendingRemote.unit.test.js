/**
 * Unit tests for Problem A/B fixes in quotaService pending-remote paths.
 * Uses a fake pool — no real PostgreSQL required.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function loadQuotaWithFakePool(fakeQuery) {
  // Fresh require after clearing cache
  const qsPath = require.resolve('../src/services/quotaService');
  const poolPath = require.resolve('../src/db/pool');
  const pusPath = require.resolve('../src/services/providerUsageService');
  delete require.cache[qsPath];
  // Stub pool
  require.cache[poolPath] = {
    id: poolPath,
    filename: poolPath,
    loaded: true,
    exports: {
      getPool: () => ({
        query: fakeQuery,
        connect: async () => ({
          query: fakeQuery,
          release: () => {},
        }),
      }),
    },
  };
  // Stub providerUsageService release/commit to track calls
  const calls = { release: [], commit: [], releaseGlobal: [] };
  const real = require.cache[pusPath] && require.cache[pusPath].exports;
  require.cache[pusPath] = {
    id: pusPath,
    filename: pusPath,
    loaded: true,
    exports: {
      ...(real || {}),
      release: async (args) => {
        calls.release.push(args);
        if (args.periodStart === 'FAIL_RELEASE') {
          const err = new Error('simulated provider ledger failure');
          err.code = 'DB_FAILURE';
          throw err;
        }
        return { ok: true };
      },
      commit: async (args) => { calls.commit.push(args); return { ok: true }; },
      releaseGlobalTomTomCalls: async (...a) => {
        calls.releaseGlobal.push(a);
        if (a[0] === 'FAIL_GLOBAL') {
          const err = new Error('simulated global ledger failure');
          err.code = 'DB_FAILURE';
          throw err;
        }
        return { ok: true };
      },
      reserve: async () => ({ ok: true }),
      reserveGlobalTomTomCalls: async () => ({ ok: true, unlimited: true }),
      commitGlobalTomTomCalls: async () => ({ ok: true }),
    },
  };
  const qs = require('../src/services/quotaService');
  return { qs, calls };
}

describe('releaseAllReservations Problem A', () => {
  afterEach(() => {
    // clear caches between tests
    for (const k of Object.keys(require.cache)) {
      if (k.includes('quotaService') || k.includes('db/pool') || k.includes('providerUsageService')) {
        delete require.cache[k];
      }
    }
  });

  it('releases when remote provider never started (no id, no signals)', async () => {
    const queries = [];
    const { qs, calls } = loadQuotaWithFakePool(async (sql, params) => {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    });
    const providers = [{
      code: 'dataforseo',
      allowed: true,
      reserve: {
        periodStart: new Date().toISOString(),
        reservedResults: 100,
        reservedCostMicroUsd: 0,
        reservedApiCalls: 1,
      },
    }];
    await qs.releaseAllReservations('user-1', 'search-1', providers);
    assert.equal(calls.release.length, 1);
    assert.equal(calls.release[0].providerCode, 'dataforseo');
    // must NOT insert intervention
    assert.equal(queries.filter((q) => /INSERT INTO pending_remote_executions/i.test(q.sql)).length, 0);
  });

  it('holds via markPendingRemote when externalRunId present', async () => {
    const inserts = [];
    const { qs, calls } = loadQuotaWithFakePool(async (sql, params) => {
      if (/INSERT INTO pending_remote_executions/i.test(String(sql))) {
        inserts.push(params);
        return { rows: [{ id: 'row-1' }] };
      }
      return { rows: [] };
    });
    const providers = [{
      code: 'dataforseo',
      allowed: true,
      externalRunId: 'task-abc',
      reserve: {
        periodStart: new Date().toISOString(),
        reservedResults: 50,
        reservedCostMicroUsd: 0,
        reservedApiCalls: 1,
      },
    }];
    await qs.releaseAllReservations('user-1', 'search-1', providers);
    assert.equal(calls.release.length, 0, 'must not release financial reserve');
    assert.ok(inserts.length >= 1);
    assert.ok(inserts[0].includes('task-abc') || inserts[0].some((p) => p === 'task-abc'));
  });

  it('intervention hold when remote may have started without id', async () => {
    const inserts = [];
    const { qs, calls } = loadQuotaWithFakePool(async (sql, params) => {
      if (/INSERT INTO pending_remote_executions/i.test(String(sql))) {
        inserts.push({ sql: String(sql), params });
        return { rows: [{ id: 'interv-1' }] };
      }
      return { rows: [] };
    });
    const providers = [{
      code: 'dataforseo',
      allowed: true,
      pendingRemote: true,
      errorCode: 'REMOTE_PERSIST_FAILED',
      reserve: {
        periodStart: new Date().toISOString(),
        reservedResults: 50,
        reservedCostMicroUsd: 0,
        reservedApiCalls: 1,
      },
    }];
    await qs.releaseAllReservations('user-1', 'search-1', providers);
    assert.equal(calls.release.length, 0, 'must not release when remote may have started');
    assert.ok(inserts.length >= 1);
    assert.ok(inserts[0].params.includes('intervention') || /intervention/.test(inserts[0].sql));
  });
});

describe('resolvePendingRemoteAfterCommit Problem B', () => {
  afterEach(() => {
    for (const k of Object.keys(require.cache)) {
      if (k.includes('quotaService') || k.includes('db/pool') || k.includes('providerUsageService')) {
        delete require.cache[k];
      }
    }
  });

  it('UPDATE restricts to status=pending and expired/null lease', async () => {
    let seenSql = '';
    const { qs } = loadQuotaWithFakePool(async (sql) => {
      seenSql = String(sql);
      return { rows: [{ id: 'p1' }] };
    });
    const out = await qs.resolvePendingRemoteAfterCommit('u1', 's1', 'dataforseo', { results: 10, apiCalls: 1 });
    assert.equal(out.ok, true);
    assert.match(seenSql, /status = 'pending'/);
    assert.doesNotMatch(seenSql, /status IN \('pending', 'reconciling'\)/);
    assert.match(seenSql, /lease_owner IS NULL|lease_expires_at/);
    assert.match(seenSql, /clock_timestamp\(\)/);
  });
});

describe('markPendingRemote financial idempotency', () => {
  afterEach(() => {
    for (const k of Object.keys(require.cache)) {
      if (k.includes('quotaService') || k.includes('db/pool') || k.includes('providerUsageService')) {
        delete require.cache[k];
      }
    }
  });

  const reservation = () => ({
    periodStart: '2026-11-24T00:00:00.000Z',
    reservedResults: 50,
    reservedCostMicroUsd: 1200,
    reservedApiCalls: 1,
    unitCostMicroUsd: 24,
    fixedExecutionCostMicroUsd: 0,
    includeFixedCost: false,
    pricingVersion: 'v1',
  });

  it('uses one atomic upsert for unknown remote intervention', async () => {
    let captured;
    const { qs } = loadQuotaWithFakePool(async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO pending_remote_executions/i.test(s)) {
        captured = { sql: s, params };
        return { rows: [{ id: 'intervention-1', status: 'intervention', external_run_id: null }] };
      }
      return { rows: [] };
    });

    const result = await qs.markPendingRemote(
      'user-1', 'search-1', 'dataforseo', reservation(),
      { unknownRemote: true, reason: 'request_timeout' }
    );

    assert.equal(result.id, 'intervention-1');
    assert.equal(result.status, 'intervention');
    assert.match(captured.sql, /ON CONFLICT \(search_id, provider_code\)/);
    assert.match(captured.sql, /status IN \('pending', 'reconciling', 'intervention'\)/);
    assert.equal(captured.params[3], 'intervention');
    assert.equal(captured.params[4], null);
  });

  it('uses the same atomic upsert and promotes intervention when remote ID arrives', async () => {
    let captured;
    const { qs } = loadQuotaWithFakePool(async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO pending_remote_executions/i.test(s)) {
        captured = { sql: s, params };
        return { rows: [{ id: 'pending-1', status: 'pending', external_run_id: 'task-123' }] };
      }
      return { rows: [] };
    });

    const result = await qs.markPendingRemote(
      'user-1', 'search-1', 'dataforseo', reservation(),
      { externalRunId: 'task-123' }
    );

    assert.equal(result.status, 'pending');
    assert.equal(result.externalRunId, 'task-123');
    assert.match(captured.sql, /pending_remote_executions\.status = 'intervention'/);
    assert.match(captured.sql, /pending_remote_executions\.external_run_id IS NULL/);
  });

  it('rejects an existing row when its financial identity does not match', async () => {
    const { qs } = loadQuotaWithFakePool(async () => ({ rows: [] }));

    await assert.rejects(
      qs.markPendingRemote(
        'user-1', 'search-1', 'dataforseo', reservation(),
        { externalRunId: 'task-123' }
      ),
      (err) => err.code === 'PENDING_REMOTE_RESERVATION_CONFLICT'
    );
  });

  it('checks every financial identity field in the conflict update', async () => {
    let sqlSeen = '';
    const { qs } = loadQuotaWithFakePool(async (sql) => {
      const s = String(sql);
      if (/INSERT INTO pending_remote_executions/i.test(s)) sqlSeen = s;
      if (/INSERT INTO pending_remote_executions/i.test(s)) {
        return { rows: [{ id: 'pending-1', status: 'pending', external_run_id: 'task-123' }] };
      }
      return { rows: [] };
    });

    await qs.markPendingRemote(
      'user-1', 'search-1', 'dataforseo', reservation(),
      { externalRunId: 'task-123' }
    );

    for (const field of [
      'user_id',
      'period_start',
      'reserved_results',
      'reserved_cost_micro_usd',
      'reserved_api_calls',
      'unit_cost_micro_usd',
      'fixed_execution_cost_micro_usd',
      'include_fixed_cost',
      'pricing_version',
    ]) {
      assert.match(sqlSeen, new RegExp(`pending_remote_executions\\.${field}`));
    }
    assert.match(sqlSeen, /IS NOT DISTINCT FROM EXCLUDED\.unit_cost_micro_usd/);
    assert.match(sqlSeen, /IS NOT DISTINCT FROM EXCLUDED\.pricing_version/);
  });
});


describe('releaseAllReservations failure propagation', () => {
  afterEach(() => {
    for (const k of Object.keys(require.cache)) {
      if (k.includes('quotaService') || k.includes('db/pool') || k.includes('providerUsageService')) {
        delete require.cache[k];
      }
    }
  });

  it('aggregates provider release failures and continues processing other providers', async () => {
    const { qs, calls } = loadQuotaWithFakePool(async () => ({ rows: [] }));

    await assert.rejects(
      qs.releaseAllReservations('user-1', 'search-1', [
        {
          allowed: true,
          code: 'brightdata',
          reserve: { periodStart: 'FAIL_RELEASE', reservedResults: 10 },
        },
        {
          allowed: true,
          code: 'dataforseo',
          reserve: { periodStart: '2026-11-24T00:00:00.000Z', reservedResults: 10 },
        },
      ]),
      (err) => {
        assert.equal(err.code, 'RELEASE_RESERVATIONS_FAILED');
        assert.equal(err.failures.length, 1);
        assert.equal(err.failures[0].providerCode, 'brightdata');
        return true;
      }
    );

    assert.equal(calls.release.length, 2);
  });

  it('propagates global TomTom reservation release failures', async () => {
    const { qs } = loadQuotaWithFakePool(async () => ({ rows: [] }));

    await assert.rejects(
      qs.releaseAllReservations('user-1', 'search-1', [], {
        globalTomTom: {
          periodStart: 'FAIL_GLOBAL',
          reservedCalls: 5,
        },
      }),
      (err) => err.code === 'RELEASE_RESERVATIONS_FAILED'
        && err.failures.length === 1
        && (err.failures[0].providerCode === 'tomtom' || err.failures[0].providerCode === 'tomtom_global')
    );
  });
});
