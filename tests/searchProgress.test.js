const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapProviderUiStatus } = require('../src/services/searchService');

describe('provider progress mapping', () => {
  it('maps ok/empty/not_configured/error/cancel', () => {
    assert.equal(mapProviderUiStatus('ok'), 'completed');
    assert.equal(mapProviderUiStatus('empty'), 'no_results');
    assert.equal(mapProviderUiStatus('not_configured'), 'not_configured');
    assert.equal(mapProviderUiStatus('error'), 'failed');
    assert.equal(mapProviderUiStatus('running'), 'running');
    assert.equal(mapProviderUiStatus('pending'), 'pending');
    assert.equal(mapProviderUiStatus('error', 'CANCELLED'), 'cancelled');
  });
});
