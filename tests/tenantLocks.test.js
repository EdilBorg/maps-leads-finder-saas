/**
 * Unit tests for src/db/tenantLocks.js — no PostgreSQL required.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  VALID_KINDS,
  isUuid,
  optionalUuid,
  tenantKeyString,
  normalizeTenantKeys,
  lockTenantKey,
  lockSubscription,
  lockSearch,
  lockSearchResult,
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
    assert.equal(isUuid(undefined), false);
    assert.equal(isUuid(123), false);
    assert.equal(isUuid({}), false);
  });

  it('tenantKeyString builds kind:id for valid UUID', () => {
    assert.equal(tenantKeyString('sub', U1), `sub:${U1}`);
  });

  it('lockTenantKey rejects invalid kind', async () => {
    const c = mockClient();
    await assert.rejects(() => lockTenantKey(c, 'plan', U1), /invalid kind/);
    assert.equal(c.calls.length, 0);
  });

  it('lockTenantKey rejects missing id', async () => {
    const c = mockClient();
    await assert.rejects(() => lockTenantKey(c, 'sub', null), /missing id/);
    await assert.rejects(() => lockTenantKey(c, 'sub', ''), /missing id/);
  });

  it('lockTenantKey rejects non-string and malformed UUID', async () => {
    const c = mockClient();
    await assert.rejects(() => lockTenantKey(c, 'sub', 123), /must be a string/);
    await assert.rejects(() => lockTenantKey(c, 'sub', 'abc'), /valid UUID/);
    await assert.rejects(() => lockTenantKey(c, 'sub', 'qualquer-texto'), /valid UUID/);
  });

  it('optionalUuid returns null for null/empty and validates otherwise', () => {
    assert.equal(optionalUuid(null, 'sub'), null);
    assert.equal(optionalUuid(undefined, 'sub'), null);
    assert.equal(optionalUuid('', 'sub'), null);
    assert.equal(optionalUuid(U1, 'sub'), U1);
    assert.throws(() => optionalUuid('nope', 'sub'), /valid UUID/);
  });

  it('lockTenantKey issues hashtext advisory lock with prefix and id', async () => {
    const c = mockClient();
    await lockTenantKey(c, 'sub', U1);
    assert.equal(c.calls.length, 1);
    assert.match(c.calls[0].sql, /pg_advisory_xact_lock\(hashtext/);
    assert.deepEqual(c.calls[0].params, ['sub:', U1]);
  });

  it('lockSubscription / lockSearch / lockSearchResult use correct kinds', async () => {
    const c = mockClient();
    await lockSubscription(c, U1);
    await lockSearch(c, U2);
    await lockSearchResult(c, U3);
    assert.deepEqual(c.calls[0].params, ['sub:', U1]);
    assert.deepEqual(c.calls[1].params, ['search:', U2]);
    assert.deepEqual(c.calls[2].params, ['result:', U3]);
  });

  it('normalizeTenantKeys sorts, dedupes, skips null', () => {
    const ordered = normalizeTenantKeys([
      { kind: 'sub', id: U2 },
      { kind: 'search', id: U1 },
      { kind: 'sub', id: U1 },
      { kind: 'sub', id: U2 },
      { kind: 'sub', id: null },
    ]);
    assert.deepEqual(
      ordered.map((k) => `${k.kind}:${k.id}`),
      [`search:${U1}`, `sub:${U1}`, `sub:${U2}`]
    );
  });

  it('lockTenantKeysOrdered is independent of input order', async () => {
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

  it('lockReferenceChange locks old and new in order', async () => {
    const c = mockClient();
    await lockReferenceChange(c, 'sub', U2, U1);
    assert.equal(c.calls.length, 2);
    assert.deepEqual(c.calls[0].params, ['sub:', U1]);
    assert.deepEqual(c.calls[1].params, ['sub:', U2]);
  });

  it('lockReferenceChange same old/new locks once; nulls skipped', async () => {
    const c = mockClient();
    await lockReferenceChange(c, 'search', U1, U1);
    assert.equal(c.calls.length, 1);

    const c2 = mockClient();
    await lockReferenceChange(c2, 'result', null, U2);
    assert.equal(c2.calls.length, 1);
    assert.deepEqual(c2.calls[0].params, ['result:', U2]);
  });

  it('stabilizeAndLockReferenceChange stabilizes after concurrent change', async () => {
    const c = mockClient();
    let reads = 0;
    const readCurrent = async () => {
      reads += 1;
      if (reads === 1) return U1;
      if (reads === 2) return U2;
      return U2;
    };
    const result = await stabilizeAndLockReferenceChange(c, 'sub', readCurrent, U3);
    assert.equal(result.observedCurrentId, U2);
    assert.equal(result.newId, U3);
    assert.ok(result.attempts >= 2);
    const locked = c.calls.map((x) => x.params[1]);
    assert.ok(locked.includes(U3));
  });

  it('stabilizeAndLockReferenceChange rejects invalid readCurrent', async () => {
    const c = mockClient();
    await assert.rejects(
      () => stabilizeAndLockReferenceChange(c, 'sub', null, U1),
      /readCurrent must be a function/
    );
  });

  it('propagates PostgreSQL errors from client.query', async () => {
    const c = {
      async query() {
        const err = new Error('simulated pg failure');
        err.code = '57P01';
        throw err;
      },
    };
    await assert.rejects(() => lockSubscription(c, U1), (err) => {
      assert.equal(err.message, 'simulated pg failure');
      assert.equal(err.code, '57P01');
      return true;
    });
  });
});
