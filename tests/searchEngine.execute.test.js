const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  executeSearch,
  providersForModality,
  classifySearchOutcome,
  normalizeProviderResult,
  runProviderSafe,
} = require('../src/services/searchEngine');

function mockProvider(code, status, results, opts = {}) {
  return {
    code,
    async search() {
      if (opts.throwError) {
        const err = new Error(opts.throwMessage || 'boom');
        err.code = opts.throwCode || 'PROVIDER_ERROR';
        throw err;
      }
      if (Object.prototype.hasOwnProperty.call(opts, 'raw')) return opts.raw;
      return {
        status,
        results: results || [],
        errorCode: status === 'error' ? opts.errorCode || 'E' : null,
        errorMessage: status === 'error' ? opts.errorMessage || 'err' : null,
        errorStage: opts.errorStage || null,
        httpStatus: opts.httpStatus != null ? opts.httpStatus : null,
      };
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

describe('classifySearchOutcome matrix', () => {
  it('results + results → completed/results', () => {
    assert.deepEqual(classifySearchOutcome(['ok', 'ok'], true), {
      outcome: 'results',
      searchStatus: 'completed',
    });
  });
  it('results + empty → completed/results', () => {
    assert.deepEqual(classifySearchOutcome(['ok', 'empty'], true), {
      outcome: 'results',
      searchStatus: 'completed',
    });
  });
  it('results + error → partial/results', () => {
    assert.deepEqual(classifySearchOutcome(['ok', 'error'], true), {
      outcome: 'results',
      searchStatus: 'partial',
    });
  });
  it('empty + empty → completed/no_results', () => {
    assert.deepEqual(classifySearchOutcome(['empty', 'empty'], false), {
      outcome: 'no_results',
      searchStatus: 'completed',
    });
  });
  it('empty + error → inconclusive / partial', () => {
    assert.deepEqual(classifySearchOutcome(['empty', 'error'], false), {
      outcome: 'inconclusive',
      searchStatus: 'partial',
    });
  });
  it('error + error → failed/error', () => {
    assert.deepEqual(classifySearchOutcome(['error', 'error'], false), {
      outcome: 'error',
      searchStatus: 'failed',
    });
  });
  it('not_configured + empty → inconclusive / partial', () => {
    assert.deepEqual(classifySearchOutcome(['not_configured', 'empty'], false), {
      outcome: 'inconclusive',
      searchStatus: 'partial',
    });
  });
  it('empty + not_configured → inconclusive / partial', () => {
    assert.deepEqual(classifySearchOutcome(['empty', 'not_configured'], false), {
      outcome: 'inconclusive',
      searchStatus: 'partial',
    });
  });
  it('not_configured + results → partial/results', () => {
    assert.deepEqual(classifySearchOutcome(['not_configured', 'ok'], true), {
      outcome: 'results',
      searchStatus: 'partial',
    });
  });
  it('all not_configured → failed/error', () => {
    assert.deepEqual(classifySearchOutcome(['not_configured', 'not_configured'], false), {
      outcome: 'error',
      searchStatus: 'failed',
    });
  });
});

describe('normalizeProviderResult', () => {
  it('handles null and non-object', () => {
    assert.equal(normalizeProviderResult(null).status, 'error');
    assert.equal(normalizeProviderResult('x').status, 'error');
  });
  it('handles non-array results on ok', () => {
    const r = normalizeProviderResult({ status: 'ok', results: null });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'INVALID_RESPONSE');
  });
  it('coerces ok with empty array to empty', () => {
    assert.equal(normalizeProviderResult({ status: 'ok', results: [] }).status, 'empty');
  });
  it('preserves errorStage and httpStatus from provider', () => {
    const r = normalizeProviderResult({
      status: 'error',
      results: [],
      errorCode: 'HTTP_ERROR',
      errorMessage: 'geocode HTTP 403',
      errorStage: 'geocode',
      httpStatus: 403,
    });
    assert.equal(r.errorStage, 'geocode');
    assert.equal(r.httpStatus, 403);
    assert.equal(r.errorCode, 'HTTP_ERROR');
  });
});

describe('runProviderSafe isolation', () => {
  it('captures thrown exceptions', async () => {
    const r = await runProviderSafe(
      mockProvider('osm', 'ok', [], { throwError: true, throwCode: 'HTTP_ERROR' }),
      { query: 'x', location: 'y' }
    );
    assert.equal(r.result.status, 'error');
    assert.equal(r.result.errorCode, 'HTTP_ERROR');
    assert.equal(r.result.results.length, 0);
  });
  it('handles missing search function', async () => {
    const r = await runProviderSafe({ code: 'ghost', search: null }, { query: 'x', location: 'y' });
    assert.equal(r.result.status, 'error');
    assert.equal(r.result.errorCode, 'PROVIDER_MISSING');
  });
});

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
    assert.equal(r.results.length, 2);
  });

  it('first ok second empty → completed results', async () => {
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
    assert.equal(r.searchStatus, 'completed');
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

  it('empty + error → inconclusive (does not claim no establishments)', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'empty', []),
        osm: mockProvider('osm', 'error', []),
      },
    });
    assert.equal(r.outcome, 'inconclusive');
    assert.equal(r.searchStatus, 'partial');
    assert.equal(r.results.length, 0);
  });

  it('exception from one provider does not block the other', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [], {
          throwError: true,
          throwCode: 'TIMEOUT',
          throwMessage: 'timeout',
        }),
        osm: mockProvider('osm', 'ok', [lead('B', '2', 'osm')]),
      },
    });
    assert.equal(r.outcome, 'results');
    assert.equal(r.searchStatus, 'partial');
    assert.equal(r.results.length, 1);
    assert.equal(r._providers.find((p) => p.code === 'google_maps').status, 'error');
    assert.equal(r._providers.find((p) => p.code === 'osm').status, 'ok');
  });

  it('exception from both providers → failed', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [], { throwError: true }),
        osm: mockProvider('osm', 'ok', [], { throwError: true }),
      },
    });
    assert.equal(r.outcome, 'error');
    assert.equal(r.searchStatus, 'failed');
  });

  it('missing provider in registry does not throw and records error', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [lead('A', '1', 'google_maps')]),
        osm: { code: 'osm' },
      },
    });
    assert.equal(r.outcome, 'results');
    assert.equal(r.searchStatus, 'partial');
    const osmDiag = r._providers.find((p) => p.code === 'osm');
    assert.ok(osmDiag);
    assert.equal(osmDiag.status, 'error');
    assert.equal(osmDiag.errorCode, 'PROVIDER_MISSING');
  });

  it('invalid null response becomes provider error without crashing', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [], { raw: null }),
        osm: mockProvider('osm', 'ok', [lead('B', '2', 'osm')]),
      },
    });
    assert.equal(r.results.length, 1);
    assert.equal(r.searchStatus, 'partial');
    assert.equal(r._providers.find((p) => p.code === 'google_maps').status, 'error');
  });

  it('invalid results shape does not throw', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [], { raw: { status: 'ok', results: 'bad' } }),
        osm: mockProvider('osm', 'empty', []),
      },
    });
    assert.equal(r.outcome, 'inconclusive');
    assert.equal(r._providers.find((p) => p.code === 'google_maps').status, 'error');
  });

  it('expanded modality: apify results + google error → partial', async () => {
    const r = await executeSearch({
      modality: 'expanded',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'error', []),
        apify: mockProvider('apify', 'ok', [lead('A', '1', 'apify')]),
      },
    });
    assert.equal(r.modality, 'expanded');
    assert.equal(r.outcome, 'results');
    assert.equal(r.searchStatus, 'partial');
    assert.equal(r.results.length, 1);
    assert.ok(!r._providers.some((p) => p.code === 'osm'));
  });

  it('not_configured + results keeps results with partial status', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'not_configured', []),
        osm: mockProvider('osm', 'ok', [lead('B', '2', 'osm')]),
      },
    });
    assert.equal(r.outcome, 'results');
    assert.equal(r.searchStatus, 'partial');
    assert.equal(r._providers.find((p) => p.code === 'google_maps').status, 'not_configured');
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

  it('noWebsite: true removes leads with website', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      filters: { noWebsite: true },
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [
          lead('WithWeb', '1', 'google_maps', { website: 'https://a.example' }),
          lead('NoWeb', '2', 'google_maps', { website: null }),
        ]),
        osm: mockProvider('osm', 'empty', []),
      },
    });
    assert.equal(r.totals.afterFilters, 1);
    assert.equal(r.results[0].name, 'NoWeb');
  });

  it('noWebsite: false keeps leads with website', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      filters: { noWebsite: false },
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [
          lead('WithWeb', '1', 'google_maps', { website: 'https://a.example' }),
        ]),
        osm: mockProvider('osm', 'empty', []),
      },
    });
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].name, 'WithWeb');
  });

  it('not_configured + empty → inconclusive partial (not no_results)', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'not_configured', []),
        osm: mockProvider('osm', 'empty', []),
      },
    });
    assert.equal(r.outcome, 'inconclusive');
    assert.equal(r.searchStatus, 'partial');
  });

  it('google later-page failure preserves results as partial', async () => {
    const googleProvider = {
      code: 'google_maps',
      async search() {
        return {
          status: 'error',
          results: [
            {
              name: 'Kept',
              address: 'Rua 1',
              phone: null,
              email: null,
              website: null,
              rating: 4,
              reviewsCount: 1,
              category: 'test',
              lat: 1,
              lng: 1,
              sourceProvider: 'google_maps',
              externalId: 'kept',
            },
          ],
          errorCode: 'INVALID_RESPONSE',
          errorMessage: 'pagination invalid',
        };
      },
    };
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: googleProvider,
        osm: mockProvider('osm', 'empty', []),
      },
    });
    assert.equal(r.outcome, 'results');
    assert.equal(r.searchStatus, 'partial');
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].name, 'Kept');
    const g = r._providers.find((p) => p.code === 'google_maps');
    assert.equal(g.status, 'error');
    assert.equal(g.errorCode, 'INVALID_RESPONSE');
  });

  it('executeSearch retains OSM diagnostics in _providers without leaking to results', async () => {
    const osm = {
      code: 'osm',
      async search() {
        return {
          status: 'error',
          results: [],
          errorCode: 'HTTP_ERROR',
          errorMessage: 'overpass HTTP 502',
          errorStage: 'overpass',
          httpStatus: 502,
        };
      },
    };
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'ok', [lead('A', '1', 'google_maps')]),
        osm,
      },
    });
    assert.equal(r.outcome, 'results');
    assert.equal(r.searchStatus, 'partial');
    const diag = r._providers.find((p) => p.code === 'osm');
    assert.equal(diag.status, 'error');
    assert.equal(diag.errorCode, 'HTTP_ERROR');
    assert.equal(diag.errorStage, 'overpass');
    assert.equal(diag.httpStatus, 502);
    for (const item of r.results) {
      assert.equal(item.errorStage, undefined);
      assert.equal(item.httpStatus, undefined);
      assert.equal(item.errorCode, undefined);
    }
  });

  it('diagnostics retained on total failure', async () => {
    const r = await executeSearch({
      modality: 'standard',
      query: 'x',
      location: 'y',
      providers: {
        google_maps: mockProvider('google_maps', 'error', [], { errorCode: 'HTTP_429' }),
        osm: mockProvider('osm', 'error', [], { errorCode: 'TIMEOUT' }),
      },
    });
    assert.equal(r.outcome, 'error');
    assert.equal(r._providers.length, 2);
    assert.equal(r._providers[0].errorCode, 'HTTP_429');
    assert.equal(r._providers[1].errorCode, 'TIMEOUT');
  });
});
