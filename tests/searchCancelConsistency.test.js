const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  markPendingProvidersCancelled,
  mapProviderUiStatus,
} = require('../src/services/searchService');

describe('cancel provider consistency', () => {
  it('marks all pending/running as cancelled', () => {
    const out = markPendingProvidersCancelled([
      { code: 'apify', status: 'running', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'foursquare', status: 'running', count: 3 },
    ]);
    assert.deepEqual(
      out.map((p) => p.status),
      ['cancelled', 'cancelled', 'cancelled']
    );
    assert.equal(out[2].count, 3);
  });

  it('preserves completed provider', () => {
    const out = markPendingProvidersCancelled([
      { code: 'apify', status: 'completed', count: 12 },
      { code: 'tomtom', status: 'running', count: 0 },
      { code: 'foursquare', status: 'pending', count: 0 },
    ]);
    assert.equal(out[0].status, 'completed');
    assert.equal(out[0].count, 12);
    assert.equal(out[1].status, 'cancelled');
    assert.equal(out[2].status, 'cancelled');
  });

  it('preserves no_results, not_configured, failed', () => {
    const out = markPendingProvidersCancelled([
      { code: 'apify', status: 'no_results', count: 0 },
      { code: 'tomtom', status: 'not_configured', count: 0 },
      { code: 'foursquare', status: 'failed', count: 0, errorCode: 'HTTP_ERROR' },
    ]);
    assert.equal(out[0].status, 'no_results');
    assert.equal(out[1].status, 'not_configured');
    assert.equal(out[2].status, 'failed');
    assert.equal(out[2].errorCode, 'HTTP_ERROR');
  });

  it('handles empty/null arrays', () => {
    assert.deepEqual(markPendingProvidersCancelled([]), []);
    assert.deepEqual(markPendingProvidersCancelled(null), []);
  });

  it('mapProviderUiStatus stays aligned', () => {
    assert.equal(mapProviderUiStatus('ok'), 'completed');
    assert.equal(mapProviderUiStatus('empty'), 'no_results');
    assert.equal(mapProviderUiStatus('error', 'CANCELLED'), 'cancelled');
  });
});
