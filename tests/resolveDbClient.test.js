/**
 * Unit tests for resolveDbClient / recoverAbandonedSearches client ownership.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveDbClient, recoverAbandonedSearches } = require('../src/services/freeSearchHold');

describe('resolveDbClient', () => {
  it('treats object with release as PoolClient (even if connect exists)', () => {
    const client = {
      query: async () => ({}),
      connect: async () => {
        throw new Error('must not call connect on PoolClient');
      },
      release: () => {},
    };
    const r = resolveDbClient(client);
    assert.equal(r.source, 'client');
    assert.equal(r.shouldRelease, false);
    assert.equal(r.client, client);
    assert.equal(r.pool, undefined);
  });

  it('treats object with connect and no release as Pool', () => {
    const pool = {
      query: async () => ({}),
      connect: async () => ({ query: async () => ({}), release: () => {} }),
    };
    const r = resolveDbClient(pool);
    assert.equal(r.source, 'pool');
    assert.equal(r.shouldRelease, true);
    assert.equal(r.client, null);
    assert.equal(r.pool, pool);
  });

  it('treats query-only object as query-object', () => {
    const q = { query: async () => ({}) };
    const r = resolveDbClient(q);
    assert.equal(r.source, 'query-object');
    assert.equal(r.shouldRelease, false);
    assert.equal(r.client, q);
  });

  it('rejects invalid objects', () => {
    assert.throws(() => resolveDbClient(null), /requires a pg/);
    assert.throws(() => resolveDbClient({}), /requires a pg/);
    assert.throws(() => resolveDbClient({ connect: () => {} }), /requires a pg/);
  });
});

describe('recoverAbandonedSearches ownership', () => {
  it('does not call connect or release on external PoolClient', async () => {
    let connectCalls = 0;
    let releaseCalls = 0;
    const client = {
      query: async (sql) => {
        if (/BEGIN|COMMIT|FOR UPDATE|UPDATE/i.test(sql)) return { rows: [], rowCount: 0 };
        return { rows: [] };
      },
      connect: async () => {
        connectCalls += 1;
        throw new Error('Client has already been connected');
      },
      release: () => {
        releaseCalls += 1;
      },
    };

    const result = await recoverAbandonedSearches(client, { graceMinutes: 30 });
    assert.equal(connectCalls, 0);
    assert.equal(releaseCalls, 0);
    assert.ok(typeof result.abandoned === 'number');
  });

  it('acquires and releases exactly once when given a Pool', async () => {
    let connectCalls = 0;
    let releaseCalls = 0;
    const acquired = {
      query: async (sql) => {
        if (/BEGIN|COMMIT|FOR UPDATE|UPDATE/i.test(sql)) return { rows: [], rowCount: 0 };
        return { rows: [] };
      },
      release: () => {
        releaseCalls += 1;
      },
    };
    const pool = {
      query: async () => ({}),
      connect: async () => {
        connectCalls += 1;
        return acquired;
      },
    };

    await recoverAbandonedSearches(pool, { graceMinutes: 30 });
    assert.equal(connectCalls, 1);
    assert.equal(releaseCalls, 1);
  });

  it('releases acquired Pool client on error', async () => {
    let releaseCalls = 0;
    const acquired = {
      query: async (sql) => {
        if (/BEGIN/i.test(sql)) return { rows: [] };
        if (/ROLLBACK/i.test(sql)) return { rows: [] };
        throw new Error('forced_query_error');
      },
      release: () => {
        releaseCalls += 1;
      },
    };
    const pool = {
      query: async () => ({}),
      connect: async () => acquired,
    };

    await assert.rejects(
      () => recoverAbandonedSearches(pool, { graceMinutes: 30 }),
      /forced_query_error/
    );
    assert.equal(releaseCalls, 1);
  });
});
