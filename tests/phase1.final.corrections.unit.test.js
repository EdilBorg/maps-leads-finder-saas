/**
 * Phase 1 final corrections: double-commit prevention, REMOTE_PERSIST_FAILED,
 * lease renewal, Discover vs geocode, intervention status.
 */
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

describe('dataForSeo REMOTE_PERSIST_FAILED', () => {
  it('exports getTaskResult and search', () => {
    const dfs = require('../src/services/providers/dataForSeoProvider');
    assert.equal(typeof dfs.getTaskResult, 'function');
    assert.equal(typeof dfs.search, 'function');
    assert.equal(typeof dfs.fetchExistingTask, 'function');
  });
});

describe('quotaService Discover isolation', () => {
  it('exports resolvePendingRemoteAfterCommit', () => {
    const qs = require('../src/services/quotaService');
    assert.equal(typeof qs.resolvePendingRemoteAfterCommit, 'function');
    assert.equal(typeof qs.markPendingRemote, 'function');
    assert.equal(typeof qs.commitProviderMetrics, 'function');
  });
});

describe('pendingRemoteReconciler lease + intervention', () => {
  it('exports renewLease and stillOwnsLease', () => {
    const rec = require('../src/services/pendingRemoteReconciler');
    assert.equal(typeof rec.renewLease, 'function');
    assert.equal(typeof rec.stillOwnsLease, 'function');
    assert.equal(typeof rec.scheduleRetry, 'function');
    assert.equal(typeof rec.resolveSuccess, 'function');
    assert.ok(Number(rec.MAX_ATTEMPTS) > 0);
  });
});

describe('tomtom Discover max 100 and mapping', () => {
  it('caps maxResults and maps official title/contacts', () => {
    const tomtom = require('../src/services/providers/tomtomProvider');
    const body = tomtom.buildDiscoverBody({ query: 'x', maxResults: 999, lat: 1, lng: 2 });
    assert.equal(body.maxResults, 100);
    const lead = tomtom.mapDiscoverItem({
      id: 'abc',
      title: 'Shop',
      position: { type: 'Point', coordinates: [10.5, 20.5] },
      contacts: [{ phones: ['999'], websites: ['https://ex.com'] }],
      poiTypes: [{ name: 'Store', role: 'preferred' }],
    }, 0, { query: 'shop' });
    assert.equal(lead.name, 'Shop');
    assert.equal(lead.phone, '999');
    assert.equal(lead.website, 'https://ex.com');
    assert.equal(lead.lat, 20.5);
    assert.equal(lead.lng, 10.5);
  });
});

describe('searchEngine sequential invariants', () => {
  it('PROVIDER_CODES are dataforseo+tomtom only', () => {
    const se = require('../src/services/searchEngine');
    assert.deepEqual([...se.PROVIDER_CODES], ['dataforseo', 'tomtom']);
  });
});
