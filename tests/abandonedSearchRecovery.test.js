const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  runOnce,
  startAbandonedSearchRecovery,
  stopAbandonedSearchRecovery,
  waitForIdle,
  ADVISORY_KEY,
} = require('../src/services/abandonedSearchRecovery');

describe('abandonedSearchRecovery job', () => {
  afterEach(() => {
    stopAbandonedSearchRecovery();
    delete process.env.ENABLE_ABANDONED_SEARCH_RECOVERY;
  });

  it('skips when advisory lock is held', async () => {
    let released = false;
    let unlocked = false;
    let destroyArg = null;
    const client = {
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: false }] };
        if (sql.includes('pg_advisory_unlock')) {
          unlocked = true;
          return { rows: [{ ok: true }] };
        }
        return { rows: [] };
      },
      release(arg) { released = true; destroyArg = arg; },
    };
    const result = await runOnce({
      getPool: () => ({ connect: async () => client }),
      recoverAbandonedSearches: async () => { throw new Error('should not run'); },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'lock_held');
    assert.equal(released, true);
    assert.equal(unlocked, false);
    assert.equal(destroyArg, undefined);
  });

  it('runs recover with PoolClient and unlocks same session', async () => {
    const sqls = [];
    let released = false;
    let destroyArg = null;
    let recoverGotClient = null;
    const client = {
      async query(sql, params) {
        sqls.push(sql.slice(0, 40));
        if (sql.includes('pg_try_advisory_lock')) {
          assert.equal(params[0], ADVISORY_KEY);
          return { rows: [{ ok: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          assert.equal(params[0], ADVISORY_KEY);
          return { rows: [{ ok: true }] };
        }
        return { rows: [] };
      },
      release(arg) { released = true; destroyArg = arg; },
    };
    const result = await runOnce({
      getPool: () => ({ connect: async () => client }),
      recoverAbandonedSearches: async (db) => {
        recoverGotClient = db;
        assert.equal(typeof db.release, 'function');
        assert.equal(typeof db.connect, 'undefined');
        return { abandoned: 2, holdsReleased: 1 };
      },
    });
    assert.equal(result.skipped, false);
    assert.equal(result.abandoned, 2);
    assert.equal(recoverGotClient, client);
    assert.equal(released, true);
    assert.equal(destroyArg, undefined);
    assert.ok(sqls.some((s) => s.includes('pg_try_advisory_lock')));
    assert.ok(sqls.some((s) => s.includes('pg_advisory_unlock')));
  });

  it('destroys connection when unlock returns false', async () => {
    let destroyArg = null;
    const client = {
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ ok: false }] };
        return { rows: [] };
      },
      release(arg) { destroyArg = arg; },
    };
    await runOnce({
      getPool: () => ({ connect: async () => client }),
      recoverAbandonedSearches: async () => ({ abandoned: 0, holdsReleased: 0 }),
    });
    assert.equal(destroyArg, true);
  });

  it('destroys connection when unlock throws', async () => {
    let destroyArg = null;
    const client = {
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
        if (sql.includes('pg_advisory_unlock')) throw new Error('unlock boom');
        return { rows: [] };
      },
      release(arg) { destroyArg = arg; },
    };
    await runOnce({
      getPool: () => ({ connect: async () => client }),
      recoverAbandonedSearches: async () => ({ abandoned: 0, holdsReleased: 0 }),
    });
    assert.equal(destroyArg, true);
  });

  it('releases connection even when recover throws', async () => {
    let released = false;
    let unlocked = false;
    let destroyArg = null;
    const client = {
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
        if (sql.includes('pg_advisory_unlock')) {
          unlocked = true;
          return { rows: [{ ok: true }] };
        }
        return { rows: [] };
      },
      release(arg) { released = true; destroyArg = arg; },
    };
    await assert.rejects(
      () =>
        runOnce({
          getPool: () => ({ connect: async () => client }),
          recoverAbandonedSearches: async () => { throw new Error('boom'); },
        }),
      /boom/
    );
    assert.equal(released, true);
    assert.equal(unlocked, true);
    assert.equal(destroyArg, undefined);
  });

  it('start is disabled without ENABLE flag', () => {
    const r = startAbandonedSearchRecovery();
    assert.equal(r.started, false);
    assert.equal(r.reason, 'disabled');
  });

  it('start enables scheduler when flag is set', () => {
    process.env.ENABLE_ABANDONED_SEARCH_RECOVERY = '1';
    const r = startAbandonedSearchRecovery();
    assert.equal(r.started, true);
    stopAbandonedSearchRecovery();
  });

  it('waitForIdle resolves when not running', async () => {
    const ok = await waitForIdle(100);
    assert.equal(ok, true);
  });
});
