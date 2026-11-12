const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const google = require('../src/services/providers/googleMapsProvider');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function placeFixture(id, overrides = {}) {
  return {
    id,
    displayName: { text: overrides.name || `Place ${id}` },
    formattedAddress: overrides.address || `${id} Street`,
    location: {
      latitude: overrides.lat != null ? overrides.lat : -25.9,
      longitude: overrides.lng != null ? overrides.lng : 32.5,
    },
    types: overrides.types || ['restaurant'],
    primaryType: overrides.primaryType || 'restaurant',
    rating: overrides.rating != null ? overrides.rating : 4.2,
    userRatingCount: overrides.userRatingCount != null ? overrides.userRatingCount : 15,
    internationalPhoneNumber: Object.prototype.hasOwnProperty.call(overrides, 'intl')
      ? overrides.intl
      : '+258 84 000 0000',
    nationalPhoneNumber: Object.prototype.hasOwnProperty.call(overrides, 'national')
      ? overrides.national
      : '84 000 0000',
    websiteUri: Object.prototype.hasOwnProperty.call(overrides, 'website')
      ? overrides.website
      : 'https://example.com',
  };
}

function mockFetchSequence(responses) {
  let i = 0;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (spec.throwNetwork) {
      const err = new Error(spec.message || 'network');
      err.code = spec.code || 'NETWORK';
      throw err;
    }
    return {
      ok: spec.ok !== false && (spec.status == null || (spec.status >= 200 && spec.status < 300)),
      status: spec.status != null ? spec.status : 200,
      async text() {
        if (spec.rawText != null) return spec.rawText;
        return JSON.stringify(spec.body != null ? spec.body : {});
      },
      async json() {
        return spec.body != null ? spec.body : {};
      },
    };
  };
  return calls;
}

describe('googleMapsProvider Places API (New)', () => {
  beforeEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-google-key-12345678';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = ORIGINAL_FETCH;
  });

  it('returns not_configured without API key', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const r = await google.search({ query: 'x', location: 'y', limit: 10 });
    assert.equal(r.status, 'not_configured');
    assert.equal(r.results.length, 0);
  });

  it('maps first page results including phone website rating coords id', async () => {
    mockFetchSequence([
      {
        body: {
          places: [
            placeFixture('places/abc', {
              name: 'Cafe Bom',
              intl: '+258 21 111',
              website: 'https://cafe.example',
              rating: 4.5,
              userRatingCount: 22,
              lat: -25.97,
              lng: 32.58,
              primaryType: 'cafe',
            }),
          ],
        },
      },
    ]);
    const r = await google.search({ query: 'cafe', location: 'Maputo', limit: 10 });
    assert.equal(r.status, 'ok');
    assert.equal(r.results.length, 1);
    const lead = r.results[0];
    assert.equal(lead.name, 'Cafe Bom');
    assert.equal(lead.phone, '+258 21 111');
    assert.equal(lead.website, 'https://cafe.example');
    assert.equal(lead.email, null);
    assert.equal(lead.rating, 4.5);
    assert.equal(lead.reviewsCount, 22);
    assert.equal(lead.lat, -25.97);
    assert.equal(lead.lng, 32.58);
    assert.equal(lead.sourceProvider, 'google_maps');
    assert.equal(lead.externalId, 'places/abc');
    assert.equal(lead.category, 'cafe');
  });

  it('falls back to national phone when international missing', async () => {
    mockFetchSequence([
      {
        body: {
          places: [placeFixture('p1', { intl: null, national: '84 999 8888' })],
        },
      },
    ]);
    const r = await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.results[0].phone, '84 999 8888');
  });

  it('email remains null even when other contact fields exist', async () => {
    mockFetchSequence([{ body: { places: [placeFixture('p1')] } }]);
    const r = await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.results[0].email, null);
  });

  it('returns empty when places array is empty', async () => {
    mockFetchSequence([{ body: { places: [] } }]);
    const r = await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'empty');
    assert.equal(r.results.length, 0);
  });

  it('paginates two pages and sends pageToken on second request', async () => {
    const calls = mockFetchSequence([
      {
        body: {
          places: [placeFixture('a'), placeFixture('b')],
          nextPageToken: 'TOKEN_2',
        },
      },
      {
        body: {
          places: [placeFixture('c')],
        },
      },
    ]);
    const r = await google.search({ query: 'clinica', location: 'Maputo', limit: 10 });
    assert.equal(r.status, 'ok');
    assert.equal(r.results.length, 3);
    assert.equal(calls.length, 2);
    const body1 = JSON.parse(calls[0].init.body);
    const body2 = JSON.parse(calls[1].init.body);
    assert.equal(body1.textQuery.includes('clinica'), true);
    assert.equal(body1.pageToken, undefined);
    assert.equal(body2.pageToken, 'TOKEN_2');
    assert.equal(body2.textQuery, body1.textQuery);
  });

  it('paginates three pages', async () => {
    const calls = mockFetchSequence([
      { body: { places: [placeFixture('1')], nextPageToken: 't2' } },
      { body: { places: [placeFixture('2')], nextPageToken: 't3' } },
      { body: { places: [placeFixture('3')] } },
    ]);
    const r = await google.search({ query: 'x', location: 'y', limit: 10 });
    assert.equal(r.results.length, 3);
    assert.equal(calls.length, 3);
  });

  it('stops when limit is reached before all pages', async () => {
    const calls = mockFetchSequence([
      {
        body: {
          places: Array.from({ length: 20 }, (_, i) => placeFixture(`p${i}`)),
          nextPageToken: 'MORE',
        },
      },
      {
        body: {
          places: Array.from({ length: 20 }, (_, i) => placeFixture(`q${i}`)),
          nextPageToken: 'EVEN_MORE',
        },
      },
    ]);
    const r = await google.search({ query: 'x', location: 'y', limit: 25 });
    assert.equal(r.results.length, 25);
    assert.equal(calls.length, 2);
    const body2 = JSON.parse(calls[1].init.body);
    assert.ok(body2.pageSize <= 20);
    assert.ok(body2.pageSize <= 5);
  });

  it('stops when nextPageToken is absent', async () => {
    const calls = mockFetchSequence([
      { body: { places: [placeFixture('only')] } },
    ]);
    const r = await google.search({ query: 'x', location: 'y', limit: 50 });
    assert.equal(r.results.length, 1);
    assert.equal(calls.length, 1);
  });

  it('never requests more than 20 results per page', async () => {
    const calls = mockFetchSequence([
      { body: { places: [placeFixture('a')] } },
    ]);
    await google.search({ query: 'x', location: 'y', limit: 100 });
    const body = JSON.parse(calls[0].init.body);
    assert.ok(body.pageSize <= 20);
  });

  it('deduplicates by place id across pages', async () => {
    mockFetchSequence([
      {
        body: {
          places: [placeFixture('dup'), placeFixture('a')],
          nextPageToken: 't2',
        },
      },
      {
        body: {
          places: [placeFixture('dup'), placeFixture('b')],
        },
      },
    ]);
    const r = await google.search({ query: 'x', location: 'y', limit: 20 });
    assert.equal(r.results.length, 3);
    const ids = r.results.map((x) => x.externalId);
    assert.deepEqual(ids.sort(), ['a', 'b', 'dup'].sort());
  });

  it('HTTP error on first page returns error without results', async () => {
    mockFetchSequence([
      {
        ok: false,
        status: 500,
        body: { error: { message: 'backend error' } },
      },
    ]);
    const r = await google.search({ query: 'x', location: 'y', limit: 10 });
    assert.equal(r.status, 'error');
    assert.equal(r.results.length, 0);
    assert.ok(r.errorCode);
  });

  it('error on later page preserves accumulated results', async () => {
    mockFetchSequence([
      {
        body: {
          places: [placeFixture('kept')],
          nextPageToken: 't2',
        },
      },
      {
        ok: false,
        status: 503,
        body: { error: { message: 'unavailable' } },
      },
    ]);
    const r = await google.search({ query: 'x', location: 'y', limit: 20 });
    assert.equal(r.status, 'error');
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].externalId, 'kept');
  });

  it('invalid JSON returns error', async () => {
    mockFetchSequence([{ ok: true, status: 200, rawText: '{not-json' }]);
    const r = await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.results.length, 0);
  });

  it('response without places field is error not empty', async () => {
    mockFetchSequence([{ body: { foo: 1 } }]);
    const r = await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'INVALID_RESPONSE');
    assert.equal(r.results.length, 0);
  });

  it('empty object response is error not empty', async () => {
    mockFetchSequence([{ body: {} }]);
    const r = await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'INVALID_RESPONSE');
  });

  it('places null is error not empty', async () => {
    mockFetchSequence([{ body: { places: null } }]);
    const r = await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'INVALID_RESPONSE');
  });

  it('places non-array is error not empty', async () => {
    mockFetchSequence([{ body: { places: 'invalid' } }]);
    const r = await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'INVALID_RESPONSE');
  });

  it('invalid places on second page preserves first page results', async () => {
    mockFetchSequence([
      {
        body: {
          places: [placeFixture('kept')],
          nextPageToken: 't2',
        },
      },
      { body: { foo: 1 } },
    ]);
    const r = await google.search({ query: 'x', location: 'y', limit: 20 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'INVALID_RESPONSE');
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].externalId, 'kept');
  });

  it('quota/permission errors surface as error status', async () => {
    mockFetchSequence([
      {
        ok: false,
        status: 403,
        body: { error: { message: 'PERMISSION_DENIED' } },
      },
    ]);
    const r = await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'AUTH_ERROR');
  });

  it('API key is never placed in the URL', async () => {
    const calls = mockFetchSequence([{ body: { places: [] } }]);
    await google.search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(calls[0].url.includes('key='), false);
    assert.equal(calls[0].url.includes(process.env.GOOGLE_MAPS_API_KEY), false);
    assert.equal(calls[0].url, google.SEARCH_URL);
    assert.equal(calls[0].init.headers['X-Goog-Api-Key'], process.env.GOOGLE_MAPS_API_KEY);
  });

  it('uses explicit FieldMask without wildcard', async () => {
    const calls = mockFetchSequence([{ body: { places: [] } }]);
    await google.search({ query: 'x', location: 'y', limit: 5 });
    const mask = calls[0].init.headers['X-Goog-FieldMask'];
    assert.equal(mask.includes('*'), false);
    assert.equal(mask.includes('places.nationalPhoneNumber'), true);
    assert.equal(mask.includes('nextPageToken'), true);
    assert.equal(google.FIELD_MASK.includes('*'), false);
  });

  it('mapPlace falls back category to types[0] then query', () => {
    const a = google.mapPlace(
      { id: '1', displayName: { text: 'A' }, types: ['store'] },
      'loja'
    );
    assert.equal(a.category, 'store');
    const b = google.mapPlace({ id: '2', displayName: { text: 'B' } }, 'loja');
    assert.equal(b.category, 'loja');
  });
});
