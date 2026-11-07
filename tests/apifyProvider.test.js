const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildActorInput, escapeJsonString, mapItem } = require('../src/services/providers/apifyProvider');

describe('apifyProvider unit', () => {
  it('escapeJsonString handles quotes', () => {
    assert.equal(escapeJsonString('a"b'), 'a\\"b');
  });

  it('buildActorInput default keys', () => {
    delete process.env.APIFY_INPUT_JSON;
    delete process.env.APIFY_INPUT_QUERY_KEY;
    const body = buildActorInput({ query: 'cafés', location: 'Maputo', limit: 10 });
    assert.equal(body.search, 'cafés');
    assert.equal(body.location, 'Maputo');
    assert.equal(body.maxItems, 10);
  });

  it('buildActorInput JSON template with special chars stays valid', () => {
    process.env.APIFY_INPUT_JSON = '{"q":"{{query}}","loc":"{{location}}","n":{{limit}}}';
    const body = buildActorInput({ query: 'foo"bar', location: 'a\\b', limit: 5 });
    assert.equal(body.q, 'foo"bar');
    assert.equal(body.n, 5);
    delete process.env.APIFY_INPUT_JSON;
  });

  it('mapItem fills defaults', () => {
    const m = mapItem({ title: 'X' }, 0, { query: 'q' });
    assert.equal(m.name, 'X');
    assert.equal(m.sourceProvider, 'apify');
  });
});
