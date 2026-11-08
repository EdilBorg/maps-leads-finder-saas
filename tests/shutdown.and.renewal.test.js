const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { performShutdown } = require('../src/services/shutdownManager');
const {
  stopAbandonedSearchRecovery,
  waitForIdle,
  _setRunningForTests,
  startAbandonedSearchRecovery,
} = require('../src/services/abandonedSearchRecovery');

describe('performShutdown', () => {
  afterEach(() => {
    stopAbandonedSearchRecovery();
    if (_setRunningForTests) _setRunningForTests(false);
  });

  it('closes pool when job is already idle', async () => {
    let closeCalls = 0;
    const result = await performShutdown({
      state: { shuttingDown: false },
      waitForIdle: async () => true,
      closePool: async () => { closeCalls += 1; },
      stopAbandonedSearchRecovery: () => {},
      log: () => {},
      error: () => {},
    });
    assert.equal(closeCalls, 1);
    assert.equal(result.poolClosed, true);
    assert.equal(result.idle, true);
  });

  it('does NOT close pool when waitForIdle returns false', async () => {
    let closeCalls = 0;
    const logs = [];
    const result = await performShutdown({
      state: { shuttingDown: false },
      waitForIdle: async () => false,
      closePool: async () => { closeCalls += 1; },
      stopAbandonedSearchRecovery: () => {},
      log: () => {},
      error: (m) => logs.push(String(m)),
    });
    assert.equal(closeCalls, 0);
    assert.equal(result.poolClosed, false);
    assert.ok(logs.some((l) => l.includes('still running')));
  });

  it('second concurrent shutdown is a no-op', async () => {
    const state = { shuttingDown: false };
    let closeCalls = 0;
    const p1 = performShutdown({
      state,
      waitForIdle: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return true;
      },
      closePool: async () => { closeCalls += 1; },
      stopAbandonedSearchRecovery: () => {},
      log: () => {},
      error: () => {},
    });
    const p2 = await performShutdown({
      state,
      waitForIdle: async () => true,
      closePool: async () => { closeCalls += 10; },
      stopAbandonedSearchRecovery: () => {},
      log: () => {},
      error: () => {},
    });
    assert.equal(p2.alreadyShuttingDown, true);
    await p1;
    assert.equal(closeCalls, 1);
  });

  it('stopAbandonedSearchRecovery prevents new ticks', async () => {
    process.env.ENABLE_ABANDONED_SEARCH_RECOVERY = '1';
    startAbandonedSearchRecovery();
    stopAbandonedSearchRecovery();
    const idle = await waitForIdle(200);
    assert.equal(idle, true);
    delete process.env.ENABLE_ABANDONED_SEARCH_RECOVERY;
  });
});

describe('startHoldRenewal', () => {
  const { startHoldRenewal } = require('../src/services/searchService');

  it('renews successfully and releases connection', async () => {
    let released = 0;
    let renewCalls = 0;
    const client = { release() { released += 1; } };
    const stop = startHoldRenewal('u1', 'tok', {
      intervalMs: 30,
      searchId: 's1',
      getPool: () => ({ connect: async () => client }),
      renewFn: async () => { renewCalls += 1; return { renewed: true, holdUntil: new Date() }; },
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    assert.ok(renewCalls >= 1);
    assert.equal(released, renewCalls);
  });

  it('stops when renewed is false', async () => {
    let renewCalls = 0;
    const logs = [];
    const stop = startHoldRenewal('u1', 'tok', {
      intervalMs: 20,
      getPool: () => ({ connect: async () => ({ release() {} }) }),
      renewFn: async () => { renewCalls += 1; return { renewed: false }; },
      log: (m) => logs.push(m),
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    assert.equal(renewCalls, 1);
    assert.ok(logs.includes('not_renewable'));
  });

  it('logs connect errors without logging the token', async () => {
    const logs = [];
    const stop = startHoldRenewal('u1', 'secret-token-xyz', {
      intervalMs: 20,
      getPool: () => ({ connect: async () => { throw new Error('connect refused'); } }),
      renewFn: async () => ({ renewed: true }),
      log: (m, e) => logs.push({ m, e }),
    });
    await new Promise((r) => setTimeout(r, 70));
    stop();
    assert.ok(logs.some((l) => l.m === 'connect_error'));
    assert.ok(logs.every((l) => !JSON.stringify(l).includes('secret-token-xyz')));
  });

  it('logs renew query errors and still releases connection', async () => {
    let released = 0;
    const logs = [];
    const stop = startHoldRenewal('u1', 'tok', {
      intervalMs: 20,
      getPool: () => ({ connect: async () => ({ release() { released += 1; } }) }),
      renewFn: async () => { throw new Error('query failed'); },
      log: (m, e) => logs.push({ m, e }),
    });
    await new Promise((r) => setTimeout(r, 70));
    stop();
    assert.ok(released >= 1);
    assert.ok(logs.some((l) => l.m === 'renew_error'));
  });

  it('does not start overlapping renewals (inFlight guard)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const stop = startHoldRenewal('u1', 'tok', {
      intervalMs: 15,
      getPool: () => ({ connect: async () => ({ release() {} }) }),
      renewFn: async () => {
        calls += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 40));
        concurrent -= 1;
        return { renewed: true };
      },
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    assert.ok(calls >= 1);
    assert.equal(maxConcurrent, 1);
  });
});
