/**
 * Unit tests for migration runner lock acquire/release — no PostgreSQL.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MIGRATION_LOCK_KEY,
  releaseMigrationLocks,
  applyMigrations,
} = require('../src/db/migrate');

describe('migrate runner unit', () => {
  it('releaseMigrationLocks true on unlock_all success', async () => {
    const client = {
      async query(sql) {
        if (sql.includes('unlock_all')) return { rows: [] };
        throw new Error('unexpected ' + sql);
      },
    };
    assert.equal(await releaseMigrationLocks(client), true);
  });

  it('releaseMigrationLocks false when unlock_all fails', async () => {
    const client = {
      async query(sql) {
        if (sql.includes('unlock_all')) throw new Error('boom');
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: false }] };
        return { rows: [] };
      },
    };
    assert.equal(await releaseMigrationLocks(client, { log: () => {} }), false);
  });

  it('destroys client when lock acquire fails', async () => {
    let released = null;
    const client = {
      async query(sql) {
        if (sql.includes('pg_advisory_lock') && !sql.includes('unlock')) {
          throw new Error('lock acquire failed');
        }
        return { rows: [] };
      },
      release(destroy) {
        released = destroy === true ? 'destroy' : 'pool';
      },
    };
    await assert.rejects(
      () => applyMigrations({ connect: async () => client }, { log: () => {} }),
      /lock acquire failed/
    );
    assert.equal(released, 'destroy');
  });

  it('returns client to pool when work succeeds and unlock ok', async () => {
    let released = null;
    const client = {
      async query(sql) {
        if (sql.includes('pg_advisory_lock') && !sql.includes('unlock')) return { rows: [] };
        if (sql.includes('unlock_all')) return { rows: [] };
        if (sql.includes('CREATE TABLE')) return { rows: [] };
        if (sql.includes('SELECT 1 FROM schema_migrations')) return { rows: [{ x: 1 }] };
        return { rows: [] };
      },
      release(destroy) {
        if (released !== null) throw new Error('double release');
        released = destroy === true ? 'destroy' : 'pool';
      },
    };
    await applyMigrations({ connect: async () => client }, { log: () => {} });
    assert.equal(released, 'pool');
  });

  it('destroys client when unlock fails after success', async () => {
    let released = null;
    const client = {
      async query(sql) {
        if (sql.includes('pg_advisory_lock') && !sql.includes('unlock')) return { rows: [] };
        if (sql.includes('unlock_all')) throw new Error('unlock_all failed');
        if (sql.includes('pg_advisory_unlock(')) return { rows: [{ unlocked: false }] };
        if (sql.includes('CREATE TABLE')) return { rows: [] };
        if (sql.includes('SELECT 1 FROM schema_migrations')) return { rows: [{ x: 1 }] };
        return { rows: [] };
      },
      release(destroy) {
        if (released !== null) throw new Error('double release');
        released = destroy === true ? 'destroy' : 'pool';
      },
    };
    await applyMigrations({ connect: async () => client }, { log: () => {} });
    assert.equal(released, 'destroy');
  });

  it('MIGRATION_LOCK_KEY is number', () => {
    assert.equal(typeof MIGRATION_LOCK_KEY, 'number');
  });
});
