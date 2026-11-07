const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeOverpassRegex,
  buildOverpassQuery,
  mapElement,
} = require('../src/services/providers/osmProvider');

describe('osmProvider unit', () => {
  it('escapeOverpassRegex escapes regex meta', () => {
    const e = escapeOverpassRegex('a.b+c');
    assert.ok(e.includes('\\.'));
    assert.ok(e.includes('\\+'));
  });

  it('buildOverpassQuery includes node and way commercial tags', () => {
    const q = buildOverpassQuery('clinica', 5000, -25.9, 32.5, 50);
    assert.match(q, /node\["shop"\]/);
    assert.match(q, /way\["shop"\]/);
    assert.match(q, /node\["amenity"\]/);
    assert.match(q, /way\["amenity"\]/);
    assert.match(q, /way\["office"\]/);
  });

  it('mapElement maps way with center', () => {
    const item = mapElement(
      {
        type: 'way',
        id: 9,
        center: { lat: 1.5, lon: 2.5 },
        tags: { name: 'Loja', shop: 'supermarket', phone: '123' },
      },
      { query: 'loja' }
    );
    assert.equal(item.name, 'Loja');
    assert.equal(item.lat, 1.5);
    assert.equal(item.externalId, 'way/9');
    assert.equal(item.phone, '123');
  });

  it('mapElement returns null without name', () => {
    assert.equal(mapElement({ type: 'node', id: 1, tags: {} }, { query: 'x' }), null);
  });
});
