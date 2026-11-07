/**
 * Unit tests for src/db/tenantLocks.js — no PostgreSQL required.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  VALID_KINDS,
  tenantKeyString,
  normalizeTenantKeys,
  lockTenantKey,
  lockSubscription,
  lockSearch,
  lockSearchResult,
  lockTenantKeysOrdered,
  lockReferenceChange,
} = require('../src/db/tenantLocks');

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

  it('tenantKeyString builds kind:id', () => {
    assert.equal(tenantKeyString('sub', 'aaa'), 'sub:aaa');
    assert.equal(tenantKeyString('search', 'bbb'), 'search:bbb');
    assert.equal(tenantKeyString('result', 'ccc'), 'result:ccc');
  });

  it('lockTenantKey rejects invalid kind', async () => {
    const c = mockClient();
    await assert.rejects(() => lockTenantKey(c, 'plan', 'x'), /invalid kind/);
    assert.equal(c.calls.length, 0);
  });

  it('lockTenantKey rejects missing id', async () => {
    const c = mockClient();
    await assert.rejects(() => lockTenantKey(c, 'sub', null), /missing id/);
    await assert.rejects(() => lockTenantKey(c, 'sub', ''), /missing id/);
    assert.equal(c.calls.length, 0);
  });

  it('lockTenantKey rejects non-string id', async () => {
    const c = mockClient();
    await assert.rejects(() => lockTenantKey(c, 'sub', 123), /must be a string/);
  });

  it('lockTenantKey issues hashtext advisory lock with prefix and id', async () => {
    const c = mockClient();
    await lockTenantKey(c, 'sub', 'uuid-1');
    assert.equal(c.calls.length, 1);
    assert.match(c.calls[0].sql, /pg_advisory_xact_lock\(hashtext/);
    assert.deepEqual(c.calls[0].params, ['sub:', 'uuid-1']);
  });

  it('lockSubscription uses sub kind', async () => {
    const c = mockClient();
    await lockSubscription(c, 's1');
    assert.deepEqual(c.calls[0].params, ['sub:', 's1']);
  });

  it('lockSearch uses search kind', async () => {
    const c = mockClient();
    await lockSearch(c, 'se1');
    assert.deepEqual(c.calls[0].params, ['search:', 'se1']);
  });

  it('lockSearchResult uses result kind', async () => {
    const c = mockClient();
    await lockSearchResult(c, 'r1');
    assert.deepEqual(c.calls[0].params, ['result:', 'r1']);
  });

  it('normalizeTenantKeys sorts lexicographically and dedupes', () => {
    const ordered = normalizeTenantKeys([
      { kind: 'sub', id: 'b' },
      { kind: 'search', id: 'a' },
      { kind: 'sub', id: 'a' },
      { kind: 'sub', id: 'b' },
    ]);
    assert.deepEqual(
      ordered.map((k) => `${k.kind}:${k.id}`),
      ['search:a', 'sub:a', 'sub:b']
    );
  });

  it('normalizeTenantKeys skips null and empty ids', () => {
    const ordered = normalizeTenantKeys([
      { kind: 'sub', id: null },
      { kind: 'sub', id: undefined },
      { kind: 'sub', id: '' },
      { kind: 'sub', id: 'only' },
    ]);
    assert.deepEqual(ordered, [{ kind: 'sub', id: 'only' }]);
  });

  it('lockTenantKeysOrdered acquires locks in sorted order regardless of input order', async () => {
    const c = mockClient();
    await lockTenantKeysOrdered(c, [
      { kind: 'result', id: 'z' },
      { kind: 'sub', id: 'a' },
      { kind: 'search', id: 'm' },
    ]);
    assert.equal(c.calls.length, 3);
    assert.deepEqual(c.calls[0].params, ['result:', 'z']);
    assert.deepEqual(c.calls[1].params, ['search:', 'm']);
    assert.deepEqual(c.calls[2].params, ['sub:', 'a']);
  });

  it('lockTenantKeysOrdered does not lock duplicates twice', async () => {
    const c = mockClient();
    await lockTenantKeysOrdered(c, [
      { kind: 'sub', id: 'same' },
      { kind: 'sub', id: 'same' },
    ]);
    assert.equal(c.calls.length, 1);
  });

  it('lockReferenceChange locks old and new parents in order', async () => {
    const c = mockClient();
    await lockReferenceChange(c, 'sub', 'sub-old', 'sub-new');
    assert.equal(c.calls.length, 2);
    const keys = c.calls.map((x) => x.params[0] + x.params[1]);
    assert.deepEqual(keys, ['sub:sub-new', 'sub:sub-old'].sort());
  });

  it('lockReferenceChange with same old and new locks once', async () => {
    const c = mockClient();
    await lockReferenceChange(c, 'search', 's1', 's1');
    assert.equal(c.calls.length, 1);
    assert.deepEqual(c.calls[0].params, ['search:', 's1']);
  });

  it('lockReferenceChange ignores null old or new', async () => {
    const c = mockClient();
    await lockReferenceChange(c, 'result', null, 'r-new');
    assert.equal(c.calls.length, 1);
    assert.deepEqual(c.calls[0].params, ['result:', 'r-new']);

    const c2 = mockClient();
    await lockReferenceChange(c2, 'result', 'r-old', null);
    assert.equal(c2.calls.length, 1);
    assert.deepEqual(c2.calls[0].params, ['result:', 'r-old']);

    const c3 = mockClient();
    await lockReferenceChange(c3, 'result', null, null);
    assert.equal(c3.calls.length, 0);
  });

  it('propagates PostgreSQL errors from client.query', async () => {
    const c = {
      async query() {
        const err = new Error('simulated pg failure');
        err.code = '57P01';
        throw err;
      },
    };
    await assert.rejects(() => lockSubscription(c, 'x'), (err) => {
      assert.equal(err.message, 'simulated pg failure');
      assert.equal(err.code, '57P01');
      return true;
    });
  });
});
