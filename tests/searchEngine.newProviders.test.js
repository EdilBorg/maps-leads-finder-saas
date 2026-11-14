const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDER_CODES,
  normalizeLimit,
  ALLOWED_LIMITS,
  deduplicate,
  executeSearch,
  normalizeLead,
} = require('../src/services/searchEngine');

describe('new search engine', () => {
  it('uses apify, tomtom, foursquare', () => {
    assert.deepEqual(PROVIDER_CODES, ['apify', 'tomtom', 'foursquare']);
  });

  it('allows only 100-500 limits', () => {
    assert.deepEqual(ALLOWED_LIMITS, [100, 200, 300, 400, 500]);
    assert.equal(normalizeLimit(50), 100);
    assert.equal(normalizeLimit(100), 100);
    assert.equal(normalizeLimit(500), 500);
    assert.equal(normalizeLimit(999), 100);
  });

  it('merges complementary fields across providers', () => {
    const a = normalizeLead({
      name: 'Barbearia X', phone: '+351912000111', address: 'Lisboa',
      sourceProvider: 'apify', externalId: 'a1',
    });
    const b = normalizeLead({
      name: 'Barbearia X', phone: '351912000111', website: 'https://barbearia.pt',
      address: 'Lisboa', sourceProvider: 'tomtom', externalId: 't1',
    });
    const out = deduplicate([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0].website, 'https://barbearia.pt');
    assert.ok(out[0].sources.includes('apify'));
    assert.ok(out[0].sources.includes('tomtom'));
  });

  it('does not merge different businesses with similar generic names far apart', () => {
    const a = normalizeLead({
      name: 'Cafe', phone: null, address: 'Porto', lat: 41.15, lng: -8.61,
      sourceProvider: 'apify', externalId: '1',
    });
    const b = normalizeLead({
      name: 'Cafe', phone: null, address: 'Lisboa', lat: 38.72, lng: -9.14,
      sourceProvider: 'tomtom', externalId: '2',
    });
    const out = deduplicate([a, b]);
    assert.equal(out.length, 2);
  });

  it('runs three providers in parallel and survives one failure', async () => {
    const providers = {
      apify: {
        code: 'apify',
        search: async () => ({
          status: 'ok',
          results: [
            { name: 'A', phone: '911111111', address: 'R1', sourceProvider: 'apify', externalId: '1' },
          ],
        }),
      },
      tomtom: {
        code: 'tomtom',
        search: async () => ({ status: 'error', results: [], errorCode: 'HTTP_ERROR' }),
      },
      foursquare: {
        code: 'foursquare',
        search: async () => ({
          status: 'ok',
          results: [
            { name: 'B', phone: '922222222', address: 'R2', sourceProvider: 'foursquare', externalId: '2' },
          ],
        }),
      },
    };
    const result2 = await executeSearch({
      query: 'barbearias',
      location: 'Lisboa',
      limit: 100,
      providers,
    });
    assert.ok(result2.results.length >= 1);
    assert.ok(['partial', 'completed'].includes(result2.searchStatus));
    const codes = result2._providers.map((p) => p.code).sort();
    assert.deepEqual(codes, ['apify', 'foursquare', 'tomtom']);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeSearch(
      {
        query: 'x',
        location: 'y',
        limit: 100,
        providers: {
          apify: { code: 'apify', search: async () => ({ status: 'ok', results: [{ name: 'Z', sourceProvider: 'apify', externalId: 'z' }] }) },
          tomtom: { code: 'tomtom', search: async () => ({ status: 'ok', results: [] }) },
          foursquare: { code: 'foursquare', search: async () => ({ status: 'ok', results: [] }) },
        },
      },
      { signal: controller.signal }
    );
    assert.equal(result.searchStatus, 'cancelled');
    assert.equal(result.results.length, 0);
  });

  it('never exceeds global limit', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      name: 'Shop ' + i,
      phone: '900000' + String(i).padStart(4, '0'),
      address: 'Addr ' + i,
      sourceProvider: 'apify',
      externalId: 'id' + i,
    }));
    const result = await executeSearch({
      query: 'loja',
      location: 'Lisboa',
      limit: 100,
      providers: {
        apify: { code: 'apify', search: async () => ({ status: 'ok', results: many }) },
        tomtom: { code: 'tomtom', search: async () => ({ status: 'empty', results: [] }) },
        foursquare: { code: 'foursquare', search: async () => ({ status: 'empty', results: [] }) },
      },
    });
    assert.ok(result.results.length <= 100);
  });
});
