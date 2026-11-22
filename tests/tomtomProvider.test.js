'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const tomtom = require('../src/services/providers/tomtomProvider');
const { withTimeout } = require('../src/services/providers/baseProvider');
const { executeSearch } = require('../src/services/searchEngine');

describe('tomtomProvider — URL construction', () => {
  it('uses pure query when country is set (no blind concatenation)', () => {
    const url = tomtom.buildSearchUrl({
      key: 'testkey',
      query: 'farmacia',
      location: 'Maputo, Moçambique',
      country: 'MZ',
      lat: -25.97,
      lng: 32.57,
      pageSize: 50,
      ofs: 0,
    });
    assert.match(url, /poiSearch\/farmacia\.json/);
    assert.ok(!url.includes('Maputo'), 'location must not be in path when country/coords present');
    assert.match(url, /countrySet=MZ/);
    assert.match(url, /lat=-25\.97/);
    assert.match(url, /lon=32\.57/);
    assert.match(url, /radius=/);
  });

  it('falls back to query+location when no structured geo', () => {
    const url = tomtom.buildSearchUrl({
      key: 'testkey',
      query: 'farmacia',
      location: 'Lisboa',
      country: null,
      lat: NaN,
      lng: NaN,
      pageSize: 20,
      ofs: 0,
    });
    assert.match(url, /poiSearch\/farmacia%20Lisboa\.json/);
  });

  it('keeps city in query when country is set but coordinates are absent', () => {
    const url = tomtom.buildSearchUrl({
      key: 'testkey',
      query: 'farmacia',
      location: 'Maputo',
      country: 'MZ',
      lat: NaN,
      lng: NaN,
      pageSize: 20,
      ofs: 0,
    });
    assert.match(url, /poiSearch\/farmacia%20Maputo\.json/, 'city must remain in path');
    assert.match(url, /countrySet=MZ/);
    assert.ok(!/lat=/.test(url), 'no lat without coordinates');
  });

  it('uses pure query with coords even when location is present', () => {
    const url = tomtom.buildSearchUrl({
      key: 'testkey',
      query: 'farmacia',
      location: 'Maputo',
      country: 'MZ',
      lat: -25.97,
      lng: 32.57,
      pageSize: 20,
      ofs: 0,
    });
    assert.match(url, /poiSearch\/farmacia\.json/);
    assert.ok(!url.includes('Maputo'));
    assert.match(url, /lat=-25\.97/);
  });

  it('supports Maputo / Beira / Nampula / Lisboa / Porto path patterns', () => {
    for (const loc of ['Maputo', 'Beira', 'Nampula', 'Lisboa', 'Porto']) {
      const url = tomtom.buildSearchUrl({
        key: 'k',
        query: 'restaurante',
        location: loc,
        country: loc === 'Lisboa' || loc === 'Porto' ? 'PT' : 'MZ',
        lat: -25,
        lng: 32,
        pageSize: 10,
        ofs: 0,
      });
      assert.match(url, /poiSearch\/restaurante\.json/);
      assert.match(url, /countrySet=(MZ|PT)/);
    }
  });
});

describe('tomtomProvider — mapItem', () => {
  it('maps POI fields without inventing data', () => {
    const item = tomtom.mapItem(
      {
        id: 'tt-1',
        poi: { name: 'Clínica Sol', phone: '+258840000000', categories: ['health'] },
        address: { freeformAddress: 'Av. Julius Nyerere, Maputo' },
        position: { lat: -25.96, lon: 32.58 },
      },
      0,
      { query: 'clinica' }
    );
    assert.equal(item.name, 'Clínica Sol');
    assert.equal(item.sourceProvider, 'tomtom');
    assert.equal(item.externalId, 'tt-1');
  });

  it('returns null when name missing', () => {
    assert.equal(tomtom.mapItem({ poi: {} }, 0, { query: 'x' }), null);
  });
});

describe('tomtomProvider — geocodeLocation structured errors', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('returns GEOCODE_NOT_FOUND on empty results', async () => {
    process.env.TOMTOM_API_KEY = 'test-key-12345678';
    global.fetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
    const r = await tomtom.geocodeLocation('Nowhereville', null, 'MZ');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'GEOCODE_NOT_FOUND');
  });

  it('returns AUTH_ERROR on 401', async () => {
    process.env.TOMTOM_API_KEY = 'test-key-12345678';
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'no' });
    const r = await tomtom.geocodeLocation('Maputo', null, 'MZ');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AUTH_ERROR');
  });

  it('returns RATE_LIMIT on 429', async () => {
    process.env.TOMTOM_API_KEY = 'test-key-12345678';
    global.fetch = async () => ({ ok: false, status: 429, text: async () => 'slow' });
    const r = await tomtom.geocodeLocation('Maputo', null, 'MZ');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'RATE_LIMIT');
  });

  it('rejects country mismatch — does not silently use first result', async () => {
    process.env.TOMTOM_API_KEY = 'test-key-12345678';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            position: { lat: 38.7, lon: -9.1 },
            address: { countryCode: 'PT' },
          },
        ],
      }),
    });
    const r = await tomtom.geocodeLocation('Maputo', null, 'MZ');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'GEOCODE_COUNTRY_MISMATCH');
  });

  it('accepts matching country result for Mozambique', async () => {
    process.env.TOMTOM_API_KEY = 'test-key-12345678';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            position: { lat: -25.97, lon: 32.57 },
            address: { countryCode: 'MZ' },
          },
        ],
      }),
    });
    const r = await tomtom.geocodeLocation('Maputo', null, 'MZ');
    assert.equal(r.ok, true);
    assert.equal(r.lat, -25.97);
    assert.equal(r.country, 'MZ');
  });

  it('flags ambiguous multi-country results when no preferred country', async () => {
    process.env.TOMTOM_API_KEY = 'test-key-12345678';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        results: [
          { position: { lat: -25.9, lon: 32.5 }, address: { countryCode: 'MZ' } },
          { position: { lat: 38.7, lon: -9.1 }, address: { countryCode: 'PT' } },
        ],
      }),
    });
    const r = await tomtom.geocodeLocation('Maputo', null, null);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'GEOCODE_AMBIGUOUS');
  });
});

describe('withTimeout aborts underlying fetch', () => {
  it('aborts factory fetch on timeout', async () => {
    let aborted = false;
    const p = withTimeout(
      (signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
      50,
      'test-timeout'
    );
    await assert.rejects(p, (e) => e.code === 'PROVIDER_TIMEOUT');
    // Allow microtask for abort listener
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(aborted, true);
  });

  it('propagates external cancel as CANCELLED', async () => {
    const ac = new AbortController();
    const p = withTimeout(
      (signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
          });
        }),
      5000,
      ac.signal
    );
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p, (e) => e.code === 'CANCELLED');
  });
});

describe('withTimeout external listener cleanup', () => {
  function instrumentSignal(signal) {
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    const counts = { addCount: 0, removeCount: 0 };

    signal.addEventListener = (...args) => {
      counts.addCount += 1;
      return originalAdd(...args);
    };
    signal.removeEventListener = (...args) => {
      counts.removeCount += 1;
      return originalRemove(...args);
    };
    return counts;
  }

  it('removes listeners after success', async () => {
    const ac = new AbortController();
    const counts = instrumentSignal(ac.signal);
    const result = await withTimeout(() => Promise.resolve('ok'), 1000, ac.signal);

    assert.equal(result, 'ok');
    assert.equal(counts.addCount, 2);
    assert.equal(counts.removeCount, counts.addCount);
  });

  it('removes listeners after timeout', async () => {
    const ac = new AbortController();
    const counts = instrumentSignal(ac.signal);
    const pending = withTimeout(() => new Promise(() => {}), 20, ac.signal);

    await assert.rejects(pending, err => err.code === 'PROVIDER_TIMEOUT');
    assert.equal(counts.removeCount, counts.addCount);
  });

  it('removes listeners after cancellation', async () => {
    const ac = new AbortController();
    const counts = instrumentSignal(ac.signal);
    const pending = withTimeout(() => new Promise(() => {}), 1000, ac.signal);

    ac.abort();
    await assert.rejects(pending, err => err.code === 'CANCELLED');
    assert.equal(counts.removeCount, counts.addCount);
  });
});

describe('executeSearch propagates geo context to TomTom', () => {
  it('passes country and coordinates for Maputo MZ', async () => {
    let seen = null;
    const result = await executeSearch(
      {
        query: 'farmacia',
        location: 'Maputo',
        country: 'MZ',
        lat: -25.97,
        lng: 32.57,
        limit: 100,
        allowedProviders: ['tomtom'],
        providers: {
          tomtom: {
            code: 'tomtom',
            search: async (criteria) => {
              seen = criteria;
              return { status: 'ok', results: [{ name: 'Farmácia A', sourceProvider: 'tomtom', externalId: '1' }] };
            },
          },
        },
      }
    );
    assert.ok(seen);
    assert.equal(seen.country, 'MZ');
    assert.equal(seen.lat, -25.97);
    assert.equal(seen.lng, 32.57);
    assert.equal(seen.query, 'farmacia');
    assert.ok(result.results.length >= 1);
  });

  it('passes country PT for Lisboa without inventing coords', async () => {
    let seen = null;
    await executeSearch(
      {
        query: 'restaurante',
        location: 'Lisboa',
        country: 'PT',
        limit: 100,
        allowedProviders: ['tomtom'],
        providers: {
          tomtom: {
            code: 'tomtom',
            search: async (criteria) => {
              seen = criteria;
              return { status: 'empty', results: [] };
            },
          },
        },
      }
    );
    assert.equal(seen.country, 'PT');
    assert.equal(seen.lat, undefined);
    assert.equal(seen.lng, undefined);
  });

  it('does not invent country from location string alone', async () => {
    let seen = null;
    await executeSearch(
      {
        query: 'loja',
        location: 'Maputo, Moçambique',
        limit: 100,
        allowedProviders: ['tomtom'],
        providers: {
          tomtom: {
            code: 'tomtom',
            search: async (criteria) => {
              seen = criteria;
              return { status: 'empty', results: [] };
            },
          },
        },
      }
    );
    assert.equal(seen.country, undefined);
  });
});
