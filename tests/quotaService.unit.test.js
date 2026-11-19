const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TRIAL_MAX_LEADS, DEFAULT_PAID_LIMITS } = require('../src/services/quotaService');
const { okResult } = require('../src/services/providers/baseProvider');
const { PROVIDER_CODES } = require('../src/services/searchEngine');

describe('quotaService constants', () => {
  it('trial max leads is 200', () => assert.equal(TRIAL_MAX_LEADS, 200));
  it('default paid limits independent', () => {
    assert.equal(DEFAULT_PAID_LIMITS.apify.maxResults, 1000);
    assert.equal(DEFAULT_PAID_LIMITS.brightdata.maxResults, 1500);
    assert.equal(DEFAULT_PAID_LIMITS.tomtom.maxResults, null);
  });
});

describe('okResult metrics', () => {
  it('attaches metrics', () => {
    const r = okResult([{ name: 'A' }], { rawCount: 5, apiCalls: 2, geocodeCalls: 1 });
    assert.equal(r.metrics.rawCount, 5);
    assert.equal(r.metrics.apiCalls, 2);
  });
  it('works without metrics', () => {
    assert.equal(okResult([]).status, 'empty');
  });
});

describe('searchEngine providers', () => {
  it('includes brightdata', () => {
    assert.ok(PROVIDER_CODES.includes('apify'));
    assert.ok(PROVIDER_CODES.includes('brightdata'));
  });
});
