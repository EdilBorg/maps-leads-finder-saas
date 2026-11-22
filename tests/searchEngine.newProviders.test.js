const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDER_CODES,
  PROVIDER_MAX,
  normalizeLimit,
  ALLOWED_LIMITS,
  providerLimit,
  deduplicate,
  executeSearch,
  normalizeLead,
  normalizeProviderResult,
} = require('../src/services/searchEngine');

describe('new search engine', () => {
  it('uses apify, tomtom, brightdata', () => {
    assert.deepEqual(PROVIDER_CODES, ['apify', 'tomtom', 'brightdata']);
  });

  it('provider max limits allow Apify up to global limit', () => {
    assert.equal(PROVIDER_MAX.apify, 500);
    assert.equal(PROVIDER_MAX.tomtom, 200);
    assert.equal(PROVIDER_MAX.brightdata, 200);
    assert.equal(providerLimit('apify', 500), 500);
    assert.equal(providerLimit('tomtom', 300), 200);
    assert.equal(providerLimit('brightdata', 500), 200);
    assert.equal(providerLimit('brightdata', 100), 100);
    assert.equal(providerLimit('apify', 100), 100);
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

  it('does not merge same name with empty addresses', () => {
    const a = normalizeLead({
      name: 'Cafe Central', phone: null, address: null,
      sourceProvider: 'apify', externalId: '1',
    });
    const b = normalizeLead({
      name: 'Cafe Central', phone: null, address: '',
      sourceProvider: 'tomtom', externalId: '2',
    });
    const out = deduplicate([a, b]);
    assert.equal(out.length, 2);
  });

  it('does not treat external ids as equal across providers', () => {
    const a = normalizeLead({
      name: 'Place A', phone: null, address: 'Street 1',
      sourceProvider: 'apify', externalId: 'same-id',
    });
    const b = normalizeLead({
      name: 'Place B', phone: null, address: 'Street 2',
      sourceProvider: 'tomtom', externalId: 'same-id',
    });
    const out = deduplicate([a, b]);
    assert.equal(out.length, 2);
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

  it('preserves provider diagnostics', () => {
    const n = normalizeProviderResult({
      status: 'error',
      results: [],
      errorCode: 'HTTP_ERROR',
      errorMessage: 'HTTP 403',
      errorStage: 'fetch',
      httpStatus: 403,
    });
    assert.equal(n.errorCode, 'HTTP_ERROR');
    assert.equal(n.errorStage, 'fetch');
    assert.equal(n.httpStatus, 403);
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
        search: async () => ({ status: 'error', results: [], errorCode: 'HTTP_ERROR', httpStatus: 500, errorStage: 'poi' }),
      },
      brightdata: {
        code: 'brightdata',
        search: async () => ({
          status: 'ok',
          results: [
            { name: 'B', phone: '922222222', address: 'R2', sourceProvider: 'brightdata', externalId: '2' },
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
    assert.deepEqual(codes, ['apify', 'brightdata', 'tomtom']);
    const tt = result2._providers.find((p) => p.code === 'tomtom');
    assert.equal(tt.errorCode, 'HTTP_ERROR');
  });

  it('fires onProviderProgress for each provider', async () => {
    const events = [];
    const providers = {
      apify: {
        code: 'apify',
        search: async () => ({ status: 'ok', results: [{ name: 'A', sourceProvider: 'apify', externalId: '1', address: 'X' }] }),
      },
      tomtom: {
        code: 'tomtom',
        search: async () => ({ status: 'empty', results: [] }),
      },
      brightdata: {
        code: 'brightdata',
        search: async () => ({ status: 'not_configured', results: [] }),
      },
    };
    await executeSearch(
      { query: 'q', location: 'l', limit: 100, providers },
      { onProviderProgress: (e) => events.push(e) }
    );
    const codes = new Set(events.map((e) => e.code));
    assert.ok(codes.has('apify'));
    assert.ok(codes.has('tomtom'));
    assert.ok(codes.has('brightdata'));
    assert.ok(events.some((e) => e.status === 'running'));
    assert.ok(events.some((e) => e.status === 'ok' || e.count > 0));
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
          brightdata: { code: 'brightdata', search: async () => ({ status: 'ok', results: [] }) },
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
        brightdata: { code: 'brightdata', search: async () => ({ status: 'empty', results: [] }) },
      },
    });
    assert.ok(result.results.length <= 100);
  });

  it('passes per-provider limit into search criteria', async () => {
    const seen = {};
    const providers = {
      apify: {
        code: 'apify',
        search: async (c) => { seen.apify = c.limit; return { status: 'empty', results: [] }; },
      },
      tomtom: {
        code: 'tomtom',
        search: async (c) => { seen.tomtom = c.limit; return { status: 'empty', results: [] }; },
      },
      brightdata: {
        code: 'brightdata',
        search: async (c) => { seen.brightdata = c.limit; return { status: 'empty', results: [] }; },
      },
    };
    await executeSearch({ query: 'q', location: 'l', limit: 500, providers });
    assert.equal(seen.apify, 500);
    assert.equal(seen.tomtom, 200);
    assert.equal(seen.brightdata, 200);
  });
});
