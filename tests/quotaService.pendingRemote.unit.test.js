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
      release: async (args) => { calls.release.push(args); return { ok: true }; },
      commit: async (args) => { calls.commit.push(args); return { ok: true }; },
      releaseGlobalTomTomCalls: async (...a) => { calls.releaseGlobal.push(a); return { ok: true }; },
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
