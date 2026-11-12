const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function shouldConsumeFreeSearch(insertedCount, outcome, searchStatus) {
  return (
    insertedCount > 0 &&
    (outcome === 'results' || searchStatus === 'partial')
  );
}

describe('free search quota consumption', () => {
  it('consumes when results present', () => {
    assert.equal(shouldConsumeFreeSearch(5, 'results', 'completed'), true);
  });
  it('consumes on partial with results', () => {
    assert.equal(shouldConsumeFreeSearch(2, 'results', 'partial'), true);
  });
  it('does not consume on no_results', () => {
    assert.equal(shouldConsumeFreeSearch(0, 'no_results', 'completed'), false);
  });
  it('does not consume on total failure', () => {
    assert.equal(shouldConsumeFreeSearch(0, 'error', 'failed'), false);
  });
  it('does not consume on inconclusive without results even if partial', () => {
    assert.equal(shouldConsumeFreeSearch(0, 'inconclusive', 'partial'), false);
  });
  it('consumes on results with partial status', () => {
    assert.equal(shouldConsumeFreeSearch(3, 'results', 'partial'), true);
  });
});
