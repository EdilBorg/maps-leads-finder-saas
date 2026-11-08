const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  runOnce,
  startAbandonedSearchRecovery,
  stopAbandonedSearchRecovery,
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
    const client = {
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ ok: false }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          unlocked = true;
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        return { rows: [] };
      },
      release() {
        released = true;
      },
    };
    const pool = {
      async connect() {
        return client;
      },
    };
    const result = await runOnce({
      getPool: () => pool,
      recoverAbandonedSearches: async () => {
        throw new Error('should not run recover when lock held');
      },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'lock_held');
    assert.equal(released, true);
    assert.equal(unlocked, false);
  });

  it('runs recover with PoolClient and unlocks same session', async () => {
    const sqls = [];
    let released = false;
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
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        return { rows: [] };
      },
      release() {
        released = true;
      },
    };
    const pool = {
      async connect() {
        return client;
      },
    };
    const result = await runOnce({
      getPool: () => pool,
      recoverAbandonedSearches: async (db) => {
        recoverGotClient = db;
        assert.equal(typeof db.release, 'function');
        assert.equal(typeof db.connect, 'undefined');
        return { abandoned: 2, holdsReleased: 1 };
      },
    });
    assert.equal(result.skipped, false);
    assert.equal(result.abandoned, 2);
    assert.equal(result.holdsReleased, 1);
    assert.equal(recoverGotClient, client);
    assert.equal(released, true);
    assert.ok(sqls.some((s) => s.includes('pg_try_advisory_lock')));
    assert.ok(sqls.some((s) => s.includes('pg_advisory_unlock')));
  });

  it('releases connection even when recover throws', async () => {
    let released = false;
    let unlocked = false;
    const client = {
      async query(sql) {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
        if (sql.includes('pg_advisory_unlock')) {
          unlocked = true;
          return { rows: [] };
        }
        return { rows: [] };
      },
      release() {
        released = true;
      },
    };
    await assert.rejects(
      () =>
        runOnce({
          getPool: () => ({ connect: async () => client }),
          recoverAbandonedSearches: async () => {
            throw new Error('boom');
          },
        }),
      /boom/
    );
    assert.equal(released, true);
    assert.equal(unlocked, true);
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
});
