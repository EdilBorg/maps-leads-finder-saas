const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { normalizeProviderResult } = require('../src/services/searchEngine');
const { backoffMs } = require('../src/services/pendingRemoteReconciler');

describe('searchService loads as complete module', () => {
  it('exports startSearch and CRM helpers', () => {
    const s = require('../src/services/searchService');
    assert.equal(typeof s.startSearch, 'function');
    assert.equal(typeof s.cancelSearch, 'function');
    assert.equal(typeof s.listSavedLeads, 'function');
    assert.equal(typeof s.saveLeadsFromResults, 'function');
  });
  it('is not a broken chunk loader', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/searchService.js'), 'utf8');
    assert.doesNotMatch(src, /wchunk/);
    assert.doesNotMatch(src, /SEE_FILE/);
    assert.match(src, /async function startSearch/);
  });
});

describe('normalizeProviderResult preserves operational metadata', () => {
  it('keeps metrics and external ids', () => {
    const r = normalizeProviderResult({
      status: 'ok',
      results: [{ name: 'A' }],
      metrics: { rawCount: 3, apiCalls: 1, runId: 'run-1' },
      externalRunId: 'run-1',
      runId: 'run-1',
    });
    assert.equal(r.metrics.rawCount, 3);
    assert.equal(r.externalRunId, 'run-1');
    assert.equal(r.runId, 'run-1');
  });
});

describe('geoBlocked and onRemoteStarted wiring', () => {
  const engine = fs.readFileSync(path.join(__dirname, '../src/services/searchEngine.js'), 'utf8');
  const bd = fs.readFileSync(path.join(__dirname, '../src/services/providers/brightDataProvider.js'), 'utf8');
  const apify = fs.readFileSync(path.join(__dirname, '../src/services/providers/apifyProvider.js'), 'utf8');
  const search = fs.readFileSync(path.join(__dirname, '../src/services/searchService.js'), 'utf8');
  it('engine propagates geoBlockedProviders', () => {
    assert.match(engine, /geoBlockedProviders/);
    assert.match(engine, /dfsCriteria\.geoBlocked = true/);
    assert.match(engine, /tomtomCriteria\.geoBlocked = true/);
  });
  it('resolveGeo returns null when geoBlocked', () => {
    assert.match(bd, /criteria\.geoBlocked === true/);
  });
  it('providers await onRemoteStarted after trigger', () => {
    assert.match(apify, /onRemoteStarted/);
    assert.match(bd, /onRemoteStarted/);
  });
  it('searchService passes onRemoteStarted to engine', () => {
    assert.match(search, /onRemoteStarted:/);
    assert.match(search, /markPendingRemote/);
  });
});

describe('markPendingRemote fails closed', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/quotaService.js'), 'utf8');
  it('does not swallow DB errors with false success', () => {
    // Implementation must throw rather than catch-and-return ok
    const fnStart = src.indexOf('async function markPendingRemote');
    const fnEnd = src.indexOf('async function commitTrialGlobalTomTom', fnStart);
    const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 2000);
    assert.doesNotMatch(body, /console\.error\('\[markPendingRemote\]'/);
    assert.match(body, /PENDING_REMOTE_MISSING_ID|requires externalRunId/);
  });
});

describe('pending remote reconciler', () => {
  it('backoff grows', () => {
    assert.ok(backoffMs(0) >= 5000);
    assert.ok(backoffMs(5) > backoffMs(1));
  });
  it('uses FOR UPDATE SKIP LOCKED', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/pendingRemoteReconciler.js'), 'utf8');
    assert.match(src, /FOR UPDATE SKIP LOCKED/);
    assert.match(src, /lease_owner/);
  });
});

describe('migration 017 leases', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/017_pending_remote_execution_leases.sql'), 'utf8');
  it('adds lease columns', () => {
    assert.match(sql, /lease_owner/);
    assert.match(sql, /lease_expires_at/);
  });
});
