/**
 * Bright Data — ISO country, resolveGeo, sleep cleanup, externalId tests.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../src/services/providers/brightDataProvider');

describe('brightDataProvider — toIso2Country', () => {
  it('passes through valid ISO2', () => {
    assert.equal(provider.toIso2Country('mz'), 'MZ');
    assert.equal(provider.toIso2Country('US'), 'US');
  });

  it('converts known ISO3 to ISO2', () => {
    assert.equal(provider.toIso2Country('MOZ'), 'MZ');
    assert.equal(provider.toIso2Country('USA'), 'US');
    assert.equal(provider.toIso2Country('PRT'), 'PT');
    assert.equal(provider.toIso2Country('BRA'), 'BR');
  });

  it('returns null for unknown ISO3 (never invents with slice)', () => {
    assert.equal(provider.toIso2Country('ZZZ'), null);
    assert.equal(provider.toIso2Country('XX'), null);
    assert.equal(provider.toIso2Country('ZZ'), null);
  });

  it('accepts known ISO2 codes MZ and PT', () => {
    assert.equal(provider.toIso2Country('MZ'), 'MZ');
    assert.equal(provider.toIso2Country('mz'), 'MZ');
    assert.equal(provider.toIso2Country('PT'), 'PT');
  });

  it('converts MOZ and rejects arbitrary XX/ZZ', () => {
    assert.equal(provider.toIso2Country('MOZ'), 'MZ');
    assert.equal(provider.toIso2Country('XX'), null);
    assert.equal(provider.toIso2Country('ZZ'), null);
  });

  it('returns null for invalid or empty values', () => {
    assert.equal(provider.toIso2Country(null), null);
    assert.equal(provider.toIso2Country(''), null);
    assert.equal(provider.toIso2Country('MOZAMBIQUE'), null);
    assert.equal(provider.toIso2Country('1'), null);
  });
});

describe('brightDataProvider — externalId stability', () => {
  it('uses place_id when present', () => {
    const item = provider.mapItem({ name: 'A', place_id: 'ChIJ1' }, 0);
    assert.equal(item.externalId, 'ChIJ1');
  });

  it('falls back to cid when place_id absent', () => {
    const item = provider.mapItem({ name: 'A', cid: '999' }, 0);
    assert.equal(item.externalId, '999');
  });

  it('uses null instead of sequential artificial id', () => {
    const a = provider.mapItem({ name: 'A' }, 0);
    const b = provider.mapItem({ name: 'B' }, 0);
    assert.equal(a.externalId, null);
    assert.equal(b.externalId, null);
  });

  it('preserves place_id and cid in raw', () => {
    const item = provider.mapItem({ name: 'A', place_id: 'ChIJ', cid: '1' }, 0);
    assert.equal(item.raw.place_id, 'ChIJ');
    assert.equal(item.raw.cid, '1');
  });
});

describe('brightDataProvider — sleep listener cleanup', () => {
  it('resolves and removes abort listener', async () => {
    const ac = new AbortController();
    let removed = false;
    const orig = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.removeEventListener = (type, fn, opts) => {
      removed = true;
      return orig(type, fn, opts);
    };
    await provider.sleep(5, ac.signal);
    assert.equal(removed, true);
  });

  it('rejects on abort and cleans up', async () => {
    const ac = new AbortController();
    const p = provider.sleep(5000, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await assert.rejects(p, (err) => err && err.code === 'CANCELLED');
  });
});

describe('brightDataProvider — resolveGeo', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('accepts explicit lat/lng/country ISO2 without network', async () => {
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: -25.9, lng: 32.5, country: 'MZ' });
    assert.deepEqual(geo, { lat: -25.9, lng: 32.5, country: 'MZ' });
  });

  it('converts explicit ISO3 country', async () => {
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: 40.7, lng: -74, country: 'USA' });
    assert.equal(geo.country, 'US');
  });

  it('uses BRIGHTDATA_DEFAULT_COUNTRY for coords without country', async () => {
    process.env.BRIGHTDATA_DEFAULT_COUNTRY = 'MZ';
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: -25.9, long: 32.5 });
    assert.equal(geo.country, 'MZ');
  });

  it('returns null when location geocode has no results', async () => {
    process.env.TOMTOM_API_KEY = 'tomtom-test-key-12345';
    delete process.env.BRIGHTDATA_DEFAULT_COUNTRY;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() { return { results: [] }; },
    });
    const geo = await provider.resolveGeo({ location: 'Nowhere' });
    assert.equal(geo, null);
  });

  it('converts TomTom ISO3 countryCodeISO3 without slicing', async () => {
    process.env.TOMTOM_API_KEY = 'tomtom-test-key-12345';
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          results: [{
            position: { lat: -25.9, lon: 32.5 },
            address: { countryCodeISO3: 'MOZ' },
          }],
        };
      },
    });
    const geo = await provider.resolveGeo({ location: 'Maputo' });
    assert.equal(geo.country, 'MZ');
    assert.equal(geo.lat, -25.9);
  });

  it('prefers countryCode ISO2 over ISO3', async () => {
    process.env.TOMTOM_API_KEY = 'tomtom-test-key-12345';
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          results: [{
            position: { lat: 1, lon: 2 },
            address: { countryCode: 'PT', countryCodeISO3: 'MOZ' },
          }],
        };
      },
    });
    const geo = await provider.resolveGeo({ location: 'Lisboa' });
    assert.equal(geo.country, 'PT');
  });

  it('returns null for unknown ISO3 from TomTom', async () => {
    process.env.TOMTOM_API_KEY = 'tomtom-test-key-12345';
    delete process.env.BRIGHTDATA_DEFAULT_COUNTRY;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          results: [{
            position: { lat: 1, lon: 2 },
            address: { countryCodeISO3: 'ZZZ' },
          }],
        };
      },
    });
    const geo = await provider.resolveGeo({ location: 'X' });
    assert.equal(geo, null);
  });
});

describe('brightDataProvider — coordinate validation', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('accepts valid coordinates with ISO2 country', async () => {
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: -25.9, lng: 32.5, country: 'MZ' });
    assert.deepEqual(geo, { lat: -25.9, lng: 32.5, country: 'MZ' });
  });

  it('accepts valid coordinates with ISO3 country', async () => {
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: 38.7, long: -9.1, country: 'PRT' });
    assert.equal(geo.country, 'PT');
    assert.equal(geo.lat, 38.7);
    assert.equal(geo.lng, -9.1);
  });

  it('rejects latitude above 90', async () => {
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: 91, lng: 0, country: 'MZ' });
    assert.equal(geo, null);
  });

  it('rejects latitude below -90', async () => {
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: -90.1, lng: 10, country: 'MZ' });
    assert.equal(geo, null);
  });

  it('rejects longitude above 180', async () => {
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: 0, lng: 181, country: 'MZ' });
    assert.equal(geo, null);
  });

  it('rejects longitude below -180', async () => {
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: 0, long: -181, country: 'MZ' });
    assert.equal(geo, null);
  });

  it('rejects non-numeric coordinates', async () => {
    global.fetch = async () => { throw new Error('fetch should not be called'); };
    const geo = await provider.resolveGeo({ lat: 'abc', lng: 10, country: 'MZ' });
    assert.equal(geo, null);
  });

  it('isValidLatLng mirrors range rules', () => {
    assert.equal(provider.isValidLatLng(0, 0), true);
    assert.equal(provider.isValidLatLng(90, 180), true);
    assert.equal(provider.isValidLatLng(-90, -180), true);
    assert.equal(provider.isValidLatLng(91, 0), false);
    assert.equal(provider.isValidLatLng(0, 181), false);
    assert.equal(provider.isValidLatLng(NaN, 0), false);
  });
});
