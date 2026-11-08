const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  acquireFreeSearchHold,
  consumeFreeSearchHold,
  releaseFreeSearchHold,
  renewFreeSearchHold,
} = require('../src/services/freeSearchHold');

function createMockClient(userState) {
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('UPDATE users SET') && s.includes('free_search_hold_token = $2') && s.includes('RETURNING id')) {
        if (!userState.free_search_used && (userState.free_search_hold_token == null || (userState.free_search_hold_until && userState.free_search_hold_until < new Date()))) {
          userState.free_search_hold_token = params[1];
          userState.free_search_hold_until = new Date(Date.now() + 20 * 60 * 1000);
          return { rows: [{ id: userState.id, free_search_used: false, free_search_hold_token: params[1], free_search_hold_until: userState.free_search_hold_until }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('SELECT free_search_used, free_search_hold_token')) return { rows: [userState], rowCount: 1 };
      if (s.includes('free_search_used = TRUE')) {
        const ok = userState.free_search_hold_token === params[1] && !userState.free_search_used && userState.free_search_hold_until && userState.free_search_hold_until > new Date();
        if (ok) {
          userState.free_search_used = true;
          userState.free_search_hold_token = null;
          userState.free_search_hold_until = null;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('RETURNING free_search_hold_until')) {
        const ok = userState.free_search_hold_token === params[1] && !userState.free_search_used && userState.free_search_hold_until && userState.free_search_hold_until > new Date();
        if (ok) {
          userState.free_search_hold_until = new Date(Date.now() + 20 * 60 * 1000);
          return { rows: [{ free_search_hold_until: userState.free_search_hold_until }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('free_search_hold_token = NULL') && s.includes('free_search_used = FALSE')) {
        if (userState.free_search_hold_token === params[1] && !userState.free_search_used) {
          userState.free_search_hold_token = null;
          userState.free_search_hold_until = null;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe('free search hold (service logic)', () => {
  it('A: first acquire succeeds', async () => {
    const user = { id: 'u1', free_search_used: false, free_search_hold_token: null, free_search_hold_until: null };
    const r = await acquireFreeSearchHold(createMockClient(user), 'u1');
    assert.equal(r.allowed, true);
  });
  it('E: concurrent second acquire fails while hold active', async () => {
    const user = { id: 'u1', free_search_used: false, free_search_hold_token: null, free_search_hold_until: null };
    const first = await acquireFreeSearchHold(createMockClient(user), 'u1');
    const second = await acquireFreeSearchHold(createMockClient(user), 'u1');
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, false);
    assert.equal(second.reason, 'FREE_SEARCH_IN_PROGRESS');
  });
  it('B: release keeps free available', async () => {
    const user = { id: 'u1', free_search_used: false, free_search_hold_token: null, free_search_hold_until: null };
    const client = createMockClient(user);
    const hold = await acquireFreeSearchHold(client, 'u1');
    await releaseFreeSearchHold(client, 'u1', hold.holdToken);
    assert.equal((await acquireFreeSearchHold(client, 'u1')).allowed, true);
  });
  it('F: valid consume sets free_search_used', async () => {
    const user = { id: 'u1', free_search_used: false, free_search_hold_token: null, free_search_hold_until: null };
    const client = createMockClient(user);
    const hold = await acquireFreeSearchHold(client, 'u1');
    assert.equal(await consumeFreeSearchHold(client, 'u1', hold.holdToken), true);
    assert.equal(user.free_search_used, true);
  });
  it('expired hold cannot be consumed', async () => {
    const user = { id: 'u1', free_search_used: false, free_search_hold_token: 'expired-token', free_search_hold_until: new Date(Date.now() - 60000) };
    assert.equal(await consumeFreeSearchHold(createMockClient(user), 'u1', 'expired-token'), false);
  });
  it('replaced token cannot be consumed', async () => {
    const user = { id: 'u1', free_search_used: false, free_search_hold_token: null, free_search_hold_until: null };
    const client = createMockClient(user);
    const first = await acquireFreeSearchHold(client, 'u1');
    user.free_search_hold_until = new Date(Date.now() - 1);
    const second = await acquireFreeSearchHold(client, 'u1');
    assert.equal(await consumeFreeSearchHold(client, 'u1', first.holdToken), false);
    assert.equal(user.free_search_hold_token, second.holdToken);
  });
  it('renew succeeds for valid token and fails for wrong token', async () => {
    const user = { id: 'u1', free_search_used: false, free_search_hold_token: null, free_search_hold_until: null };
    const client = createMockClient(user);
    const hold = await acquireFreeSearchHold(client, 'u1');
    assert.equal((await renewFreeSearchHold(client, 'u1', hold.holdToken)).renewed, true);
    assert.equal((await renewFreeSearchHold(client, 'u1', 'other')).renewed, false);
  });
  it('G: two users independent holds', async () => {
    const u1 = { id: 'u1', free_search_used: false, free_search_hold_token: null, free_search_hold_until: null };
    const u2 = { id: 'u2', free_search_used: false, free_search_hold_token: null, free_search_hold_until: null };
    const a = await acquireFreeSearchHold(createMockClient(u1), 'u1');
    const b = await acquireFreeSearchHold(createMockClient(u2), 'u2');
    assert.equal(a.allowed && b.allowed, true);
    assert.notEqual(a.holdToken, b.holdToken);
  });
});
