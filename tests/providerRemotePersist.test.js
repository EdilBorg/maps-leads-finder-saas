'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('Apify onRemoteStarted persistence', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.APIFY_TOKEN;
    delete process.env.APIFY_ACTOR_ID;
  });

  it('success callback allows search to continue to poll', async () => {
    process.env.APIFY_TOKEN = 'test-token-12345678';
    process.env.APIFY_ACTOR_ID = 'compass~crawler-google-places';
    let calls = 0;
    let aborted = false;
    global.fetch = async (url, opts) => {
      calls += 1;
      const u = String(url);
      if (u.includes('/runs?') && opts && opts.method === 'POST') {
        return { ok: true, json: async () => ({ data: { id: 'run-ok-1' } }) };
      }
      if (u.includes('/actor-runs/run-ok-1') && !u.includes('/abort') && !u.includes('/dataset')) {
        return { ok: true, json: async () => ({ data: { status: 'SUCCEEDED' } }) };
      }
      if (u.includes('/dataset/items')) {
        return { ok: true, json: async () => ([{ title: 'Shop', placeId: 'p1' }]) };
      }
      if (u.includes('/abort')) {
        aborted = true;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    };
    const apify = require('../src/services/providers/apifyProvider');
    let cbCalled = false;
    const res = await apify.search(
      { query: 'loja', location: 'Maputo', limit: 10 },
      {
        onRemoteStarted: async (info) => {
          cbCalled = true;
          assert.equal(info.externalRunId, 'run-ok-1');
        },
      }
    );
    assert.equal(cbCalled, true);
    assert.equal(res.status, 'ok');
    assert.equal(aborted, false);
  });

  it('failed callback aborts run and returns REMOTE_PERSIST_FAILED', async () => {
    process.env.APIFY_TOKEN = 'test-token-12345678';
    process.env.APIFY_ACTOR_ID = 'compass~crawler-google-places';
    let aborted = false;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/runs?') && opts && opts.method === 'POST') {
        return { ok: true, json: async () => ({ data: { id: 'run-fail-1' } }) };
      }
      if (u.includes('/abort')) {
        aborted = true;
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ data: { status: 'RUNNING' } }) };
    };
    // Fresh require not needed — module already loaded; search reads env each call
    const apify = require('../src/services/providers/apifyProvider');
    const res = await apify.search(
      { query: 'loja', location: 'Maputo', limit: 10 },
      {
        onRemoteStarted: async () => {
          throw new Error('db down');
        },
      }
    );
    assert.equal(res.status, 'error');
    assert.equal(res.errorCode, 'REMOTE_PERSIST_FAILED');
    assert.equal(aborted, true);
  });
});

describe('Apify invalid polling JSON abort', () => {
  it('aborts after eight invalid JSON responses and preserves INVALID_RESPONSE', async () => {
    process.env.APIFY_TOKEN = 'test-token-12345678';
    process.env.APIFY_ACTOR_ID = 'compass~crawler-google-places';

    const originalSetTimeout = global.setTimeout;
    let pollCalls = 0;
    let abortCalls = 0;

    global.setTimeout = (fn, ms, ...args) =>
      originalSetTimeout(fn, Math.min(Number(ms) || 0, 1), ...args);

    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/runs?') && opts && opts.method === 'POST') {
        return { ok: true, json: async () => ({ data: { id: 'run-json-invalid' } }) };
      }
      if (u.includes('/abort')) {
        abortCalls += 1;
        throw new Error('abort endpoint unavailable');
      }
      if (u.includes('/actor-runs/run-json-invalid')) {
        pollCalls += 1;
        return { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } };
      }
      throw new Error('Unexpected Apify request: ' + u);
    };

    try {
      const apify = require('../src/services/providers/apifyProvider');
      const res = await apify.search({ query: 'loja', location: 'Maputo', limit: 10 });

      assert.equal(pollCalls, 8);
      assert.equal(abortCalls, 1);
      assert.equal(res.status, 'error');
      assert.equal(res.errorCode, 'INVALID_RESPONSE');
    } finally {
      global.setTimeout = originalSetTimeout;
    }
  });
});

describe('Bright Data onRemoteStarted persistence', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.BRIGHTDATA_API_KEY;
    delete process.env.TOMTOM_API_KEY;
  });

  it('failed callback returns REMOTE_PERSIST_FAILED and does not poll', async () => {
    process.env.BRIGHTDATA_API_KEY = 'bd-key-12345678';
    let progressCalls = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/trigger')) {
        return { ok: true, json: async () => ({ snapshot_id: 'snap-1' }) };
      }
      if (u.includes('/progress/')) {
        progressCalls += 1;
        return { ok: true, json: async () => ({ status: 'running' }) };
      }
      return { ok: true, json: async () => ([]) };
    };
    const bd = require('../src/services/providers/brightDataProvider');
    const res = await bd.search(
      { query: 'loja', location: 'Maputo', lat: -25.97, lng: 32.57, country: 'MZ', limit: 10 },
      {
        onRemoteStarted: async () => {
          throw new Error('persist failed');
        },
      }
    );
    assert.equal(res.status, 'error');
    assert.equal(res.errorCode, 'REMOTE_PERSIST_FAILED');
    assert.equal(res.snapshotId, 'snap-1');
    assert.deepEqual(res.metadata, {
      snapshotId: 'snap-1',
      providerCode: 'brightdata',
      recoverable: true,
    });
    assert.equal(progressCalls, 0);
  });
});
