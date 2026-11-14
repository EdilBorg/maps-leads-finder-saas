const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildActorInput,
  escapeJsonString,
  mapItem,
  MAX_RAW,
} = require('../src/services/providers/apifyProvider');

describe('apifyProvider unit', () => {
  it('escapeJsonString handles quotes', () => {
    assert.equal(escapeJsonString('a"b'), 'a\\"b');
  });

  it('buildActorInput uses Compass fields by default', () => {
    delete process.env.APIFY_INPUT_JSON;
    const body = buildActorInput({ query: 'cafés', location: 'Maputo', limit: 10 });
    assert.deepEqual(body.searchStringsArray, ['cafés']);
    assert.equal(body.locationQuery, 'Maputo');
    assert.equal(body.maxCrawledPlacesPerSearch, 10);
  });

  it('buildActorInput caps limit at 200', () => {
    delete process.env.APIFY_INPUT_JSON;
    const body = buildActorInput({ query: 'loja', location: 'Beira', limit: 500 });
    assert.equal(body.maxCrawledPlacesPerSearch, 200);
    assert.equal(MAX_RAW, 200);
  });

  it('buildActorInput JSON template with special chars stays valid', () => {
    process.env.APIFY_INPUT_JSON = '{"q":"{{query}}","loc":"{{location}}","n":{{limit}}}';
    const body = buildActorInput({ query: 'foo"bar', location: 'a\\b', limit: 5 });
    assert.equal(body.q, 'foo"bar');
    assert.equal(body.n, 5);
    delete process.env.APIFY_INPUT_JSON;
  });

  it('mapItem maps title, categoryName, totalScore, reviewsCount, address parts', () => {
    const m = mapItem(
      {
        title: 'Clínica Sol',
        categoryName: 'Dentista',
        totalScore: 4.6,
        reviewsCount: 12,
        street: 'Av. Julius Nyerere',
        city: 'Maputo',
        countryCode: 'MZ',
        phone: '+258840000000',
        website: 'https://clinica.example',
        location: { lat: -25.96, lng: 32.57 },
        placeId: 'ChIJabc',
      },
      0,
      { query: 'dentista' }
    );
    assert.equal(m.name, 'Clínica Sol');
    assert.equal(m.category, 'Dentista');
    assert.equal(m.rating, 4.6);
    assert.equal(m.reviewsCount, 12);
    assert.match(m.address, /Julius Nyerere/);
    assert.match(m.address, /Maputo/);
    assert.equal(m.lat, -25.96);
    assert.equal(m.lng, 32.57);
    assert.equal(m.externalId, 'ChIJabc');
    assert.equal(m.sourceProvider, 'apify');
  });

  it('mapItem tolerates missing fields', () => {
    const m = mapItem({ title: 'X' }, 0, { query: 'q' });
    assert.equal(m.name, 'X');
    assert.equal(m.address, null);
    assert.equal(m.rating, null);
    assert.equal(m.sourceProvider, 'apify');
  });
});
