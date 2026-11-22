/**
 * Phase 1: sequential DataForSEO → TomTom Discover engine behaviour (mocked providers).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const searchEngine = require('../src/services/searchEngine');

function lead(name, extra = {}) {
  return {
    name,
    address: extra.address || 'Rua A 1',
    phone: extra.phone || null,
    website: extra.website || null,
    sourceProvider: extra.sourceProvider || 'dataforseo',
    externalId: extra.externalId || name,
    lat: extra.lat != null ? extra.lat : -25.9,
    lng: extra.lng != null ? extra.lng : 32.5,
  };
}

function mockProvider(code, results, status = 'ok') {
  return {
    code,
    search: async () => ({
      status,
      results: results || [],
      errorCode: status === 'error' ? 'MOCK_ERROR' : null,
      errorMessage: status === 'error' ? 'mock fail' : null,
      metrics: { rawCount: (results || []).length, apiCalls: status === 'ok' ? 1 : 0, geocodeCalls: 0 },
    }),
  };
}

describe('searchEngine phase1 sequential', () => {
  it('exports active PROVIDER_CODES as dataforseo + tomtom', () => {
    assert.deepEqual([...searchEngine.PROVIDER_CODES], ['dataforseo', 'tomtom']);
  });

  it('does not call TomTom when DataForSEO fills the limit', async () => {
    let tomtomCalls = 0;
    const dfsLeads = Array.from({ length: 100 }, (_, i) => lead('Shop ' + i, { sourceProvider: 'dataforseo' }));
    const result = await searchEngine.executeSearch(
      {
        query: 'cafe',
        location: 'Maputo',
        limit: 100,
        providers: {
          dataforseo: mockProvider('dataforseo', dfsLeads),
          tomtom: {
            code: 'tomtom',
            search: async () => {
              tomtomCalls += 1;
              return { status: 'ok', results: [], metrics: { rawCount: 0, apiCalls: 0, geocodeCalls: 0 } };
            },
          },
        },
        allowedProviders: ['dataforseo', 'tomtom'],
      },
      {}
    );
    assert.equal(tomtomCalls, 0);
    assert.equal(result.results.length, 100);
    assert.equal(result.totals.tomtomCalled, false);
  });

  it('calls TomTom once with max 100 when DataForSEO is short', async () => {
    let tomtomLimit = null;
    let tomtomCalls = 0;
    const dfsLeads = Array.from({ length: 50 }, (_, i) => lead('DFS ' + i, { sourceProvider: 'dataforseo' }));
    const ttLeads = Array.from({ length: 80 }, (_, i) => lead('TT ' + i, { sourceProvider: 'tomtom', address: 'Rua B ' + i }));
    const result = await searchEngine.executeSearch(
      {
        query: 'cafe',
        location: 'Maputo',
        limit: 200,
        providers: {
          dataforseo: mockProvider('dataforseo', dfsLeads),
          tomtom: {
            code: 'tomtom',
            search: async (criteria) => {
              tomtomCalls += 1;
              tomtomLimit = criteria.limit;
              return {
                status: 'ok',
                results: ttLeads,
                metrics: { rawCount: 80, apiCalls: 1, geocodeCalls: 0 },
              };
            },
          },
        },
        allowedProviders: ['dataforseo', 'tomtom'],
      },
      {}
    );
    assert.equal(tomtomCalls, 1);
    assert.equal(tomtomLimit, 100); // min(100, 150 missing) but limit was 200-50=150 → capped 100
    assert.ok(result.results.length <= 200);
    assert.equal(result.totals.tomtomCalled, true);
  });

  it('does not call TomTom when DataForSEO fails', async () => {
    let tomtomCalls = 0;
    const result = await searchEngine.executeSearch(
      {
        query: 'cafe',
        location: 'Maputo',
        limit: 100,
        providers: {
          dataforseo: mockProvider('dataforseo', [], 'error'),
          tomtom: {
            code: 'tomtom',
            search: async () => {
              tomtomCalls += 1;
              return { status: 'ok', results: [lead('TT')], metrics: { rawCount: 1, apiCalls: 1, geocodeCalls: 0 } };
            },
          },
        },
        allowedProviders: ['dataforseo', 'tomtom'],
      },
      {}
    );
    assert.equal(tomtomCalls, 0);
    assert.equal(result.results.length, 0);
  });

  it('preserves DataForSEO results when TomTom fails', async () => {
    const dfsLeads = Array.from({ length: 30 }, (_, i) => lead('DFS ' + i, { sourceProvider: 'dataforseo' }));
    const result = await searchEngine.executeSearch(
      {
        query: 'cafe',
        location: 'Maputo',
        limit: 100,
        providers: {
          dataforseo: mockProvider('dataforseo', dfsLeads),
          tomtom: mockProvider('tomtom', [], 'error'),
        },
        allowedProviders: ['dataforseo', 'tomtom'],
      },
      {}
    );
    assert.equal(result.results.length, 30);
  });

  it('never returns more than the requested limit', async () => {
    const dfsLeads = Array.from({ length: 80 }, (_, i) => lead('DFS ' + i, { sourceProvider: 'dataforseo' }));
    const ttLeads = Array.from({ length: 100 }, (_, i) => lead('TT ' + i, { sourceProvider: 'tomtom', address: 'Z ' + i }));
    const result = await searchEngine.executeSearch(
      {
        query: 'cafe',
        location: 'Maputo',
        limit: 100,
        providers: {
          dataforseo: mockProvider('dataforseo', dfsLeads),
          tomtom: mockProvider('tomtom', ttLeads),
        },
        allowedProviders: ['dataforseo', 'tomtom'],
      },
      {}
    );
    assert.ok(result.results.length <= 100);
  });

  it('rejects invalid limits by normalizing to 100', () => {
    assert.equal(searchEngine.normalizeLimit(999), 100);
    assert.equal(searchEngine.normalizeLimit(300), 300);
    assert.equal(searchEngine.normalizeLimit(-1), 100);
  });
});
