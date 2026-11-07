const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { executeSearch, providersForModality } = require('../src/services/searchEngine');

function mockProvider(code, status, results) {
  return {
    code,
    async search() {
      return { status, results: results || [], errorCode: status === 'error' ? 'E' : null, errorMessage: null };
    },
  };
}

function lead(name, externalId, sourceProvider, extra = {}) {
  return {
    name,
    address: extra.address || 'Rua 1',
    phone: extra.phone || null,
    email: extra.email || null,
    website: extra.website || null,
    rating: extra.rating != null ? extra.rating : 4,
    reviewsCount: extra.reviewsCount != null ? extra.reviewsCount : 10,
    category: 'test',
    lat: 1,
    lng: 1,
    sourceProvider,
    externalId,
  };
}

describe('executeSearch full pipeline with mocked providers', () => {
  it('standard modality never uses apify', async () => {
    assert.deepEqual(providersForModality('standard'), ['google_maps', 'osm']);
  });

  it('expanded modality never uses osm', async () => {
    assert.deepEqual(providersForModality('expanded'), ['google_maps', 'apify']);
  });

  it('respects global limit after merge and dedupe', async () => {
    const g = [];
    const o = [];
    for (let i = 0; i < 20; i++) {
      g.push(lead(`G${i}`, `g${i}`, 'google_maps'));
      o.push(lead(`O${i}`, `o${i}`, 'osm'));
    }
    for (let i = 0; i < 10; i++) {
      g[i].phone = `90000000${i}`;
      o[i].phone = `90000000${i}`;
      o[i].name = `Dup${i}`;
    }
    const r = await executeSearch({
      modality: 'standard',
      query: 'clinica',
      location: 'Maputo',
      limit: 15,
      providers: {
        google_maps: mockProvider('google_maps', 'ok', g),
        osm: mockProvider('osm', 'ok', o),
      },
    });
    assert.equal(r.totals.raw, 40);
    assert.ok(r.totals.afterDedup <= 40);
    assert.equal(r.totals.returned, 15);
    assert.equal(r.results.length, 15);
    assert.equal(r.outcome, 'results');
    assert.equal(r.searchStatus, 'completed');
  });

  it('both providers results → completed', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      limit: 10,
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [lead('A', '1', 'google_maps')]),
        osm: mockProvider('osm', 'ok', [lead('B', '2', 'osm')]),
      },
    });
    assert.equal(r.outcome, 'results');
    assert.equal(r.searchStatus, 'completed');
    assert.equal(r.totals.returned, 2);
  });

  it('first ok second empty', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [lead('A', '1', 'google_maps')]),
        osm: mockProvider('osm', 'empty', []),
      },
    });
    assert.equal(r.outcome, 'results');
    assert.equal(r.results.length, 1);
  });

  it('first empty second ok', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'empty', []),
        osm: mockProvider('osm', 'ok', [lead('B', '2', 'osm')]),
      },
    });
    assert.equal(r.outcome, 'results');
  });

  it('first ok second error → partial', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [lead('A', '1', 'google_maps')]),
        osm: mockProvider('osm', 'error', []),
      },
    });
    assert.equal(r.outcome, 'results');
    assert.equal(r.searchStatus, 'partial');
  });

  it('first error second ok → partial', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'error', []),
        osm: mockProvider('osm', 'ok', [lead('B', '2', 'osm')]),
      },
    });
    assert.equal(r.searchStatus, 'partial');
    assert.equal(r.results.length, 1);
  });

  it('both empty → no_results completed', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'empty', []),
        osm: mockProvider('osm', 'empty', []),
      },
    });
    assert.equal(r.outcome, 'no_results');
    assert.equal(r.searchStatus, 'completed');
    assert.equal(r.results.length, 0);
  });

  it('both error → error failed', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'error', []),
        osm: mockProvider('osm', 'error', []),
      },
    });
    assert.equal(r.outcome, 'error');
    assert.equal(r.searchStatus, 'failed');
  });

  it('filters reduce afterFilters and returned', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      limit: 50,
      filters: { hasPhone: true },
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [
          lead('A', '1', 'google_maps', { phone: '123' }),
          lead('B', '2', 'google_maps', { phone: null }),
        ]),
        osm: mockProvider('osm', 'ok', [lead('C', '3', 'osm', { phone: null })]),
      },
    });
    assert.equal(r.totals.raw, 3);
    assert.equal(r.totals.afterFilters, 1);
    assert.equal(r.totals.returned, 1);
  });

  it('metrics coherence raw >= normalized >= afterDedup path', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      limit: 5,
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [
          lead('A', '1', 'google_maps'),
          lead('A2', '1', 'google_maps'),
        ]),
        osm: mockProvider('osm', 'ok', [lead('B', '2', 'osm')]),
      },
    });
    assert.equal(r.totals.raw, 3);
    assert.equal(r.totals.normalized, 3);
    assert.ok(r.totals.afterDedup <= r.totals.normalized);
    assert.ok(r.totals.returned <= r.totals.afterFilters);
    assert.ok(r.totals.returned <= 5);
  });
});
