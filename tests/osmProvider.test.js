/**
 * OSM provider — category tag search + name-match fallback.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  search,
  resolveErrorCode,
  buildOverpassQuery,
  mapElement,
  escapeOverpassRegex,
  resolveCategory,
  normalizeText,
} = require('../src/services/providers/osmProvider');

describe('osmProvider normalize + resolveCategory', () => {
  it('normalises case, accents and whitespace', () => {
    assert.equal(normalizeText('  Restaurantes  '), 'restaurantes');
    assert.equal(normalizeText('CLÍNICA'), 'clinica');
    assert.equal(normalizeText('Salão   de   Beleza'), 'salao de beleza');
  });

  it('recognises restaurant category variants', () => {
    assert.equal(resolveCategory('Restaurantes').id, 'restaurants');
    assert.equal(resolveCategory('restaurante').id, 'restaurants');
    assert.equal(resolveCategory('RESTAURANTS').id, 'restaurants');
    assert.equal(resolveCategory('café').id, 'restaurants');
  });

  it('recognises clinics and dentists distinctly', () => {
    assert.equal(resolveCategory('Clínicas').id, 'clinics');
    assert.equal(resolveCategory('clínica').id, 'clinics');
    assert.equal(resolveCategory('clínica dentária').id, 'dentists');
    assert.equal(resolveCategory('Dentistas').id, 'dentists');
  });

  it('recognises beauty and shops', () => {
    assert.equal(resolveCategory('Salões de beleza').id, 'beauty');
    assert.equal(resolveCategory('cabeleireiro').id, 'beauty');
    assert.equal(resolveCategory('Lojas').id, 'shops');
    assert.equal(resolveCategory('loja').id, 'shops');
  });

  it('does not treat compound or unknown phrases as categories', () => {
    assert.equal(resolveCategory('Restaurantes italianos'), null);
    assert.equal(resolveCategory('Clínicas privadas'), null);
    assert.equal(resolveCategory('Padaria Central'), null);
    assert.equal(resolveCategory('Restaurante O Sabor'), null);
    assert.equal(resolveCategory(''), null);
  });
});

describe('osmProvider buildOverpassQuery — categories', () => {
  it('restaurants query uses amenity tags without name filter', () => {
    const q = buildOverpassQuery('Restaurantes', 3000, -25.97, 32.57, 40);
    assert.match(q, /amenity/);
    assert.match(q, /restaurant/);
    assert.match(q, /fast_food/);
    assert.match(q, /cafe/);
    assert.match(q, /node\["amenity"/);
    assert.match(q, /way\["amenity"/);
    assert.match(q, /relation\["amenity"/);
    assert.doesNotMatch(q, /\["name"~/);
    assert.match(q, /around:3000,-25\.97,32\.57/);
    assert.match(q, /out center 40/);
  });

  it('clinics query uses amenity and healthcare without name match', () => {
    const q = buildOverpassQuery('Clínicas', 2000, -25.9, 32.5, 25);
    assert.match(q, /\["amenity"="clinic"\]/);
    assert.match(q, /\["healthcare"="clinic"\]/);
    assert.doesNotMatch(q, /\["name"~/);
    assert.match(q, /around:2000,-25\.9,32\.5/);
    assert.match(q, /out center 25/);
  });

  it('dentists query targets amenity=dentist', () => {
    const q = buildOverpassQuery('clínica dentária', 1500, 1, 2, 10);
    assert.match(q, /\["amenity"="dentist"\]/);
    assert.doesNotMatch(q, /\["name"~/);
    assert.match(q, /node\["amenity"="dentist"\]/);
    assert.match(q, /way\["amenity"="dentist"\]/);
    assert.match(q, /relation\["amenity"="dentist"\]/);
  });

  it('beauty query uses shop beauty and hairdresser', () => {
    const q = buildOverpassQuery('Salões de beleza', 4000, 0, 0, 15);
    assert.match(q, /shop/);
    assert.match(q, /beauty|hairdresser/);
    assert.doesNotMatch(q, /\["name"~/);
  });

  it('shops category uses key-only shop filter', () => {
    const q = buildOverpassQuery('Lojas', 5000, -26, 32, 30);
    assert.match(q, /node\["shop"\]\(around:5000/);
    assert.match(q, /way\["shop"\]\(around:5000/);
    assert.match(q, /relation\["shop"\]\(around:5000/);
    assert.doesNotMatch(q, /\["name"~/);
  });

  it('caps out limit at 100', () => {
    const q = buildOverpassQuery('restaurante', 1000, 0, 0, 500);
    assert.match(q, /out center 100/);
  });
});

describe('osmProvider buildOverpassQuery — name fallback', () => {
  it('free-text still uses name regex and commercial keys', () => {
    const q = buildOverpassQuery('padaria', 2000, -25.9, 32.5, 30);
    assert.match(q, /padaria/);
    assert.match(q, /\["name"~/);
    assert.match(q, /node\["shop"\]/);
    assert.match(q, /way\["shop"\]/);
    assert.match(q, /node\["amenity"\]/);
    assert.match(q, /way\["amenity"\]/);
    assert.match(q, /way\["office"\]/);
    assert.match(q, /around:2000,-25\.9,32\.5/);
    assert.match(q, /out center 30/);
  });

  it('compound category-like phrases fall back to name search', () => {
    const q = buildOverpassQuery('Restaurantes italianos', 2500, 1, 2, 20);
    assert.match(q, /\["name"~/);
    assert.match(q, /italianos/i);
  });

  it('escapes regex metacharacters in name search', () => {
    const q = buildOverpassQuery('foo.bar+baz', 1000, 0, 0, 5);
    assert.ok(q.includes(escapeOverpassRegex('foo.bar+baz')));
    assert.match(q, /\["name"~/);
  });
});

describe('osmProvider escapeOverpassRegex', () => {
  it('escapes special characters', () => {
    assert.equal(escapeOverpassRegex('a.b'), 'a\\.b');
    assert.equal(escapeOverpassRegex('x+y'), 'x\\+y');
  });
});

describe('osmProvider mapElement', () => {
  it('mapElement maps way with center', () => {
    const item = mapElement(
      {
        type: 'way',
        id: 9,
        center: { lat: 1.5, lon: 2.5 },
        tags: { name: 'Loja', shop: 'supermarket', phone: '123' },
      },
      { query: 'loja' }
    );
    assert.equal(item.name, 'Loja');
    assert.equal(item.lat, 1.5);
    assert.equal(item.externalId, 'way/9');
    assert.equal(item.phone, '123');
    assert.equal(item.category, 'supermarket');
  });

  it('mapElement returns null without name', () => {
    assert.equal(mapElement({ type: 'node', id: 1, tags: {} }, { query: 'x' }), null);
  });

  it('mapElement maps restaurant amenity without relying on name containing category', () => {
    const item = mapElement(
      {
        type: 'node',
        id: 42,
        lat: -25.9,
        lon: 32.5,
        tags: { name: 'O Sabor', amenity: 'restaurant' },
      },
      { query: 'Restaurantes' }
    );
    assert.equal(item.name, 'O Sabor');
    assert.equal(item.category, 'restaurant');
    assert.equal(item.sourceProvider, 'osm');
  });
});

describe('osmProvider error diagnostics', () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...ORIGINAL_ENV };
  });

  function mockFetch(handler) {
    global.fetch = handler;
  }

  it('Nominatim HTTP 403 → geocode stage with httpStatus 403', async () => {
    delete process.env.OSM_DISABLED;
    mockFetch(async (url) => {
      const u = String(url);
      if (u.includes('nominatim') || u.includes('search?q=')) {
        return { ok: false, status: 403, async json() { return {}; }, async text() { return ''; } };
      }
      throw new Error('unexpected url ' + u);
    });
    const r = await search({ query: 'clinica', location: 'Maputo', limit: 10 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'HTTP_ERROR');
    assert.equal(r.errorStage, 'geocode');
    assert.equal(r.httpStatus, 403);
    assert.equal(r.results.length, 0);
  });

  it('Overpass HTTP 502 after successful geocode → overpass stage', async () => {
    delete process.env.OSM_DISABLED;
    let calls = 0;
    mockFetch(async (url, init) => {
      calls += 1;
      if (!init || init.method !== 'POST') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{ lat: '-25.97', lon: '32.57' }];
          },
        };
      }
      return { ok: false, status: 502, async json() { return {}; }, async text() { return ''; } };
    });
    const r = await search({ query: 'clinica', location: 'Maputo', limit: 10 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'HTTP_ERROR');
    assert.equal(r.errorStage, 'overpass');
    assert.equal(r.httpStatus, 502);
    assert.ok(calls >= 2);
  });

  it('network error on Nominatim preserves geocode stage', async () => {
    delete process.env.OSM_DISABLED;
    mockFetch(async () => {
      const err = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorStage, 'geocode');
    assert.equal(r.errorCode, 'ENOTFOUND');
    assert.equal(r.httpStatus, null);
  });

  it('network error on Overpass preserves overpass stage', async () => {
    delete process.env.OSM_DISABLED;
    mockFetch(async (url, init) => {
      if (!init || init.method !== 'POST') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{ lat: '1', lon: '2' }];
          },
        };
      }
      const err = new Error('socket hang up');
      err.code = 'ECONNRESET';
      throw err;
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorStage, 'overpass');
    assert.equal(r.errorCode, 'ECONNRESET');
  });

  it('timeout is classified as error with stage', async () => {
    delete process.env.OSM_DISABLED;
    mockFetch(async () => {
      const err = new Error('osm-geocode timeout after 15000ms');
      err.code = 'PROVIDER_TIMEOUT';
      throw err;
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'PROVIDER_TIMEOUT');
    assert.equal(r.errorStage, 'geocode');
  });

  it('TypeError fetch failed with cause ENOTFOUND resolves network code', async () => {
    delete process.env.OSM_DISABLED;
    mockFetch(async (url, init) => {
      if (!init || init.method !== 'POST') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{ lat: '1', lon: '2' }];
          },
        };
      }
      const cause = new Error('getaddrinfo ENOTFOUND overpass-api.de');
      cause.code = 'ENOTFOUND';
      const err = new TypeError('fetch failed');
      err.cause = cause;
      throw err;
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorStage, 'overpass');
    assert.equal(r.errorCode, 'ENOTFOUND');
    assert.equal(r.httpStatus, null);
    assert.equal(r.errorName, 'TypeError');
    assert.equal(r.causeCode, 'ENOTFOUND');
  });

  it('TypeError fetch failed with cause ECONNRESET', async () => {
    delete process.env.OSM_DISABLED;
    mockFetch(async (url, init) => {
      if (!init || init.method !== 'POST') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{ lat: '1', lon: '2' }];
          },
        };
      }
      const cause = new Error('read ECONNRESET');
      cause.code = 'ECONNRESET';
      const err = new TypeError('fetch failed');
      err.cause = cause;
      throw err;
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.errorCode, 'ECONNRESET');
    assert.equal(r.errorStage, 'overpass');
    assert.equal(r.httpStatus, null);
  });

  it('TLS cause code is preserved from fetch failed wrapper', async () => {
    delete process.env.OSM_DISABLED;
    mockFetch(async (url, init) => {
      if (!init || init.method !== 'POST') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{ lat: '1', lon: '2' }];
          },
        };
      }
      const cause = new Error('certificate has expired');
      cause.code = 'CERT_HAS_EXPIRED';
      const err = new TypeError('fetch failed');
      err.cause = cause;
      throw err;
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.errorCode, 'CERT_HAS_EXPIRED');
    assert.equal(r.errorStage, 'overpass');
    assert.equal(r.httpStatus, null);
  });

  it('error without code or cause falls back to PROVIDER_ERROR', async () => {
    delete process.env.OSM_DISABLED;
    mockFetch(async () => {
      throw new Error('something went wrong');
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'PROVIDER_ERROR');
    assert.equal(r.errorStage, 'geocode');
    assert.equal(r.httpStatus, null);
  });

  it('resolveErrorCode prefers cause for generic fetch failures', () => {
    const cause = new Error('dns');
    cause.code = 'ENOTFOUND';
    const err = new TypeError('fetch failed');
    err.cause = cause;
    assert.equal(resolveErrorCode(err), 'ENOTFOUND');
    assert.equal(resolveErrorCode(null), 'PROVIDER_ERROR');
    const plain = new Error('x');
    plain.code = 'HTTP_ERROR';
    assert.equal(resolveErrorCode(plain), 'HTTP_ERROR');
  });
});
