/**
 * Unit tests for src/db/tenantLocks.js — no PostgreSQL required.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  VALID_KINDS,
  isUuid,
  lockTenantKey,
  lockSubscription,
  lockTenantKeysOrdered,
  lockReferenceChange,
  stabilizeAndLockReferenceChange,
} = require('../src/db/tenantLocks');

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

function mockClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

describe('tenantLocks unit', () => {
  it('VALID_KINDS lists sub, search, result', () => {
    assert.deepEqual([...VALID_KINDS], ['sub', 'search', 'result']);
  });

  it('isUuid accepts valid UUIDs', () => {
    assert.equal(isUuid(U1), true);
    assert.equal(isUuid(U1.toUpperCase()), true);
  });

  it('isUuid rejects invalid values', () => {
    assert.equal(isUuid('abc'), false);
    assert.equal(isUuid('uuid-invalido'), false);
    assert.equal(isUuid(''), false);
    assert.equal(isUuid(null), false);
    assert.equal(isUuid(123), false);
  });

  it('lockTenantKey rejects malformed UUID', async () => {
    const c = mockClient();
    await assert.rejects(() => lockTenantKey(c, 'sub', 'abc'), /valid UUID/);
  });

  it('lockTenantKey issues ordered advisory SQL', async () => {
    const c = mockClient();
    await lockTenantKey(c, 'sub', U1);
    assert.match(c.calls[0].sql, /pg_advisory_xact_lock\(hashtext/);
    assert.deepEqual(c.calls[0].params, ['sub:', U1]);
  });

  it('lockTenantKeysOrdered is lexicographic', async () => {
    const c = mockClient();
    await lockTenantKeysOrdered(c, [
      { kind: 'result', id: U3 },
      { kind: 'sub', id: U1 },
      { kind: 'search', id: U2 },
    ]);
    assert.deepEqual(c.calls[0].params, ['result:', U3]);
    assert.deepEqual(c.calls[1].params, ['search:', U2]);
    assert.deepEqual(c.calls[2].params, ['sub:', U1]);
  });

  it('lockReferenceChange locks old and new once each', async () => {
    const c = mockClient();
    await lockReferenceChange(c, 'sub', U2, U1);
    assert.equal(c.calls.length, 2);
  });

  it('stabilize: FK unchanged returns observed and locks once pair', async () => {
    const c = mockClient();
    const result = await stabilizeAndLockReferenceChange(c, 'sub', async () => U1, U2);
    assert.equal(result.observedCurrentId, U1);
    assert.equal(result.newId, U2);
    assert.equal(c.calls.length, 2);
  });

  it('stabilize: FK changed throws TENANT_LOCK_RETRY without locking new observed', async () => {
    const c = mockClient();
    let reads = 0;
    const readCurrent = async () => {
      reads += 1;
      return reads === 1 ? U1 : U2;
    };
    await assert.rejects(
      () => stabilizeAndLockReferenceChange(c, 'sub', readCurrent, U3),
      (err) => err.code === 'TENANT_LOCK_RETRY'
    );
    const ids = c.calls.map((x) => x.params[1]);
    assert.ok(ids.includes(U1));
    assert.ok(ids.includes(U3));
    assert.ok(!ids.includes(U2), 'must not acquire lock for post-change value');
  });

  it('stabilize rejects non-function readCurrent', async () => {
    await assert.rejects(
      () => stabilizeAndLockReferenceChange(mockClient(), 'sub', null, U1),
      /readCurrent must be a function/
    );
  });

  it('propagates pg errors', async () => {
    const c = {
      async query() {
        const err = new Error('pg fail');
        err.code = '57P01';
        throw err;
      },
    };
    await assert.rejects(() => lockSubscription(c, U1), (e) => e.code === '57P01');
  });
});
