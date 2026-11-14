const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  executeSearch,
  providersForModality,
  classifySearchOutcome,
  normalizeProviderResult,
  runProviderSafe,
  PROVIDER_CODES,
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
    lat: extra.lat != null ? extra.lat : 1,
    lng: extra.lng != null ? extra.lng : 1,
    sourceProvider,
    externalId,
  };
}

function baseInput(providers) {
  return { query: 'cafe', location: 'Lisboa', limit: 100, providers };
}

describe('classifySearchOutcome matrix', () => {
  it('results + results → completed/results', () => {
    assert.deepEqual(classifySearchOutcome(['ok', 'ok'], true), { outcome: 'results', searchStatus: 'completed' });
  });
  it('results + empty → completed/results', () => {
    assert.deepEqual(classifySearchOutcome(['ok', 'empty'], true), { outcome: 'results', searchStatus: 'completed' });
  });
  it('results + error → partial/results', () => {
    assert.deepEqual(classifySearchOutcome(['ok', 'error'], true), { outcome: 'results', searchStatus: 'partial' });
  });
  it('empty + empty → completed/no_results', () => {
    assert.deepEqual(classifySearchOutcome(['empty', 'empty'], false), { outcome: 'no_results', searchStatus: 'completed' });
  });
  it('empty + error → inconclusive / partial', () => {
    assert.deepEqual(classifySearchOutcome(['empty', 'error'], false), { outcome: 'inconclusive', searchStatus: 'partial' });
  });
  it('error + error → failed/error', () => {
    assert.deepEqual(classifySearchOutcome(['error', 'error'], false), { outcome: 'error', searchStatus: 'failed' });
  });
  it('not_configured + empty → inconclusive / partial', () => {
    assert.deepEqual(classifySearchOutcome(['not_configured', 'empty'], false), { outcome: 'inconclusive', searchStatus: 'partial' });
  });
  it('not_configured + results → partial/results', () => {
    assert.deepEqual(classifySearchOutcome(['not_configured', 'ok'], true), { outcome: 'results', searchStatus: 'partial' });
  });
  it('all not_configured → failed/error', () => {
    assert.deepEqual(classifySearchOutcome(['not_configured', 'not_configured'], false), { outcome: 'error', searchStatus: 'failed' });
  });
});

describe('normalizeProviderResult', () => {
  it('handles null and non-object', () => {
    assert.equal(normalizeProviderResult(null).status, 'error');
    assert.equal(normalizeProviderResult('x').status, 'error');
  });
  it('handles non-array results on ok', () => {
    const r = normalizeProviderResult({ status: 'ok', results: null });
    assert.ok(['ok', 'empty', 'error'].includes(r.status));
  });
  it('coerces ok with empty array to empty', () => {
    assert.equal(normalizeProviderResult({ status: 'ok', results: [] }).status, 'empty');
  });
  it('preserves errorStage and httpStatus from provider', () => {
    const r = normalizeProviderResult({ status: 'error', results: [], errorCode: 'HTTP_ERROR', errorStage: 'fetch', httpStatus: 502 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorStage, 'fetch');
    assert.equal(r.httpStatus, 502);
  });
});

describe('runProviderSafe isolation', () => {
  it('captures thrown exceptions', async () => {
    const out = await runProviderSafe(mockProvider('apify', 'ok', [], { throwError: true, throwCode: 'HTTP_ERROR' }), { query: 'q', location: 'l', limit: 10 });
    assert.equal(out.result.status, 'error');
  });
  it('handles missing search function', async () => {
    const out = await runProviderSafe({ code: 'tomtom' }, { query: 'q', location: 'l', limit: 10 });
    assert.equal(out.result.status, 'error');
  });
});

describe('executeSearch full pipeline with mocked providers', () => {
  it('modality contract selects apify+tomtom+foursquare', () => {
    assert.deepEqual(providersForModality('standard'), PROVIDER_CODES);
    assert.deepEqual(PROVIDER_CODES, ['apify', 'tomtom', 'foursquare']);
  });

  it('respects global limit after merge and dedupe', async () => {
    const a = [], t = [], f = [];
    for (let i = 0; i < 80; i++) {
      a.push(lead(`A${i}`, `a${i}`, 'apify', { lat: i, lng: i }));
      t.push(lead(`T${i}`, `t${i}`, 'tomtom', { lat: i + 100, lng: i }));
      f.push(lead(`F${i}`, `f${i}`, 'foursquare', { lat: i + 200, lng: i }));
    }
    const r = await executeSearch(baseInput({ apify: mockProvider('apify', 'ok', a), tomtom: mockProvider('tomtom', 'ok', t), foursquare: mockProvider('foursquare', 'ok', f) }));
    assert.ok(r.totals.returned <= 100);
    assert.equal(r.results.length, r.totals.returned);
    assert.ok(r.totals.raw >= r.totals.afterDedup);
  });

  it('combines results from multiple providers', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [lead('A', '1', 'apify', { lat: 1, lng: 1 })]),
      tomtom: mockProvider('tomtom', 'ok', [lead('B', '2', 'tomtom', { lat: 2, lng: 2 })]),
      foursquare: mockProvider('foursquare', 'ok', [lead('C', '3', 'foursquare', { lat: 3, lng: 3 })]),
    }));
    assert.equal(r.outcome, 'results');
    assert.ok(r.results.length >= 3);
    assert.equal(r._providers.length, 3);
  });

  it('provider with results and another empty', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [lead('A', '1', 'apify', { lat: 1, lng: 1 })]),
      tomtom: mockProvider('tomtom', 'empty', []),
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    assert.equal(r.outcome, 'results');
    assert.ok(r.results.length >= 1);
  });

  it('empty then provider with results', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'empty', []),
      tomtom: mockProvider('tomtom', 'ok', [lead('B', '2', 'tomtom', { lat: 2, lng: 2 })]),
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    assert.equal(r.outcome, 'results');
  });

  it('partial when one provider fails and another returns results', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [lead('A', '1', 'apify', { lat: 1, lng: 1 })]),
      tomtom: mockProvider('tomtom', 'error', []),
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    assert.equal(r.searchStatus, 'partial');
    assert.equal(r.outcome, 'results');
  });

  it('failure of one provider does not block others', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'error', []),
      tomtom: mockProvider('tomtom', 'ok', [lead('B', '2', 'tomtom', { lat: 2, lng: 2 })]),
      foursquare: mockProvider('foursquare', 'ok', [lead('C', '3', 'foursquare', { lat: 3, lng: 3 })]),
    }));
    assert.equal(r.outcome, 'results');
    assert.ok(r.results.length >= 2);
  });

  it('all providers empty → no_results completed', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'empty', []),
      tomtom: mockProvider('tomtom', 'empty', []),
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    assert.equal(r.outcome, 'no_results');
    assert.equal(r.searchStatus, 'completed');
  });

  it('all providers error → failed', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'error', []),
      tomtom: mockProvider('tomtom', 'error', []),
      foursquare: mockProvider('foursquare', 'error', []),
    }));
    assert.equal(r.outcome, 'error');
    assert.equal(r.searchStatus, 'failed');
  });

  it('empty + error → inconclusive', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'empty', []),
      tomtom: mockProvider('tomtom', 'error', []),
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    assert.equal(r.outcome, 'inconclusive');
  });

  it('exception from one provider does not block the others', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [], { throwError: true }),
      tomtom: mockProvider('tomtom', 'ok', [lead('B', '2', 'tomtom', { lat: 2, lng: 2 })]),
      foursquare: mockProvider('foursquare', 'ok', [lead('C', '3', 'foursquare', { lat: 3, lng: 3 })]),
    }));
    assert.equal(r._providers.find((p) => p.code === 'apify').status, 'error');
    assert.equal(r._providers.find((p) => p.code === 'tomtom').status, 'ok');
    assert.ok(r.results.length >= 2);
  });

  it('exceptions from all providers → failed', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [], { throwError: true }),
      tomtom: mockProvider('tomtom', 'ok', [], { throwError: true }),
      foursquare: mockProvider('foursquare', 'ok', [], { throwError: true }),
    }));
    assert.equal(r.searchStatus, 'failed');
  });

  it('missing provider in registry does not throw and records error', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [lead('A', '1', 'apify', { lat: 1, lng: 1 })]),
      tomtom: { code: 'tomtom' },
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    assert.equal(r._providers.find((p) => p.code === 'tomtom').status, 'error');
    assert.ok(r.results.length >= 1);
  });

  it('null / invalid provider response is normalized', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [], { raw: null }),
      tomtom: mockProvider('tomtom', 'ok', [lead('B', '2', 'tomtom', { lat: 2, lng: 2 })]),
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    assert.ok(r.results.length >= 1);
  });

  it('invalid results structure is handled', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [], { raw: { status: 'ok', results: 'not-array' } }),
      tomtom: mockProvider('tomtom', 'empty', []),
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    assert.equal(r._providers.length, 3);
  });

  it('not_configured statuses surface in diagnostics', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'not_configured', []),
      tomtom: mockProvider('tomtom', 'not_configured', []),
      foursquare: mockProvider('foursquare', 'not_configured', []),
    }));
    assert.ok(r._providers.every((p) => p.status === 'not_configured'));
    assert.equal(r.searchStatus, 'failed');
  });

  it('metrics raw/normalized/afterDedup/afterFilters/returned are coherent', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [lead('Same', '1', 'apify', { phone: '+351900000001', lat: 10, lng: 10 })]),
      tomtom: mockProvider('tomtom', 'ok', [lead('Same', '2', 'tomtom', { phone: '+351900000001', lat: 10.00001, lng: 10 })]),
      foursquare: mockProvider('foursquare', 'ok', [lead('Other', '3', 'foursquare', { lat: 20, lng: 20 })]),
    }));
    const t = r.totals;
    assert.ok(t.raw >= t.normalized);
    assert.ok(t.normalized >= t.afterDedup);
    assert.ok(t.afterDedup >= t.afterFilters);
    assert.ok(t.afterFilters >= t.returned);
    assert.equal(r.results.length, t.returned);
  });

  it('public results do not expose internal provider diagnostics fields', async () => {
    const r = await executeSearch(baseInput({
      apify: mockProvider('apify', 'ok', [lead('A', '1', 'apify', { lat: 1, lng: 1 })]),
      tomtom: mockProvider('tomtom', 'empty', []),
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    for (const row of r.results) {
      assert.equal(Object.prototype.hasOwnProperty.call(row, 'errorCode'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(row, 'errorStage'), false);
    }
    assert.equal(r._providers.length, 3);
  });

  it('legacy provider keys in input.providers are ignored', async () => {
    const r = await executeSearch(baseInput({
      google_maps: mockProvider('google_maps', 'ok', [lead('G', 'g1', 'google_maps')]),
      osm: mockProvider('osm', 'ok', [lead('O', 'o1', 'osm')]),
      apify: mockProvider('apify', 'ok', [lead('A', 'a1', 'apify', { lat: 5, lng: 5 })]),
      tomtom: mockProvider('tomtom', 'empty', []),
      foursquare: mockProvider('foursquare', 'empty', []),
    }));
    assert.ok(r._providers.every((p) => ['apify', 'tomtom', 'foursquare'].includes(p.code)));
    assert.ok(r.results.some((x) => x.name === 'A'));
    assert.ok(!r.results.some((x) => x.name === 'G' || x.name === 'O'));
  });
});
