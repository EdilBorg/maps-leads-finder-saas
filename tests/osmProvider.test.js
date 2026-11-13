/**
 * OSM provider — category tags + name match, multi-endpoint fallback, geocode bbox.
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
  resolveOverpassEndpoints,
  extractRemarkError,
  isTransientError,
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
    assert.equal(resolveCategory('pastelaria').id, 'restaurants');
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
    assert.equal(resolveCategory('barbeiro').id, 'beauty');
    assert.equal(resolveCategory('Lojas').id, 'shops');
    assert.equal(resolveCategory('loja').id, 'shops');
  });

  it('recognises expanded categories from original catalogue', () => {
    assert.equal(resolveCategory('Farmácia').id, 'pharmacies');
    assert.equal(resolveCategory('farmacias').id, 'pharmacies');
    assert.equal(resolveCategory('Hotel').id, 'hotels');
    assert.equal(resolveCategory('hotéis').id, 'hotels');
    assert.equal(resolveCategory('Ginásio').id, 'gyms');
    assert.equal(resolveCategory('Oficina').id, 'car_repair');
    assert.equal(resolveCategory('Advogados').id, 'lawyers');
    assert.equal(resolveCategory('Padaria').id, 'bakeries');
    assert.equal(resolveCategory('Supermercado').id, 'supermarkets');
    assert.equal(resolveCategory('Roupa').id, 'clothes');
    assert.equal(resolveCategory('Veterinário').id, 'veterinary');
  });

  it('does not treat compound or unknown phrases as categories', () => {
    assert.equal(resolveCategory('Restaurantes italianos'), null);
    assert.equal(resolveCategory('Clínicas privadas'), null);
    assert.equal(resolveCategory('Padaria Central'), null);
    assert.equal(resolveCategory('Restaurante O Sabor'), null);
    assert.equal(resolveCategory('Farmácia Central'), null);
    assert.equal(resolveCategory(''), null);
  });
});

describe('osmProvider buildOverpassQuery — categories include name + tags', () => {
  it('restaurants query uses amenity tags AND name filter', () => {
    const q = buildOverpassQuery('Restaurantes', 3000, -25.97, 32.57, 40);
    assert.match(q, /amenity/);
    assert.match(q, /restaurant/);
    assert.match(q, /fast_food/);
    assert.match(q, /cafe/);
    assert.match(q, /node\["amenity"/);
    assert.match(q, /way\["amenity"/);
    assert.match(q, /relation\["amenity"/);
    // Name search must also be present
    assert.match(q, /\["name"~/);
    assert.match(q, /Restaurantes|restaurantes/i);
    assert.match(q, /around:3000,-25\.97,32\.57/);
    assert.match(q, /out center 40/);
  });

  it('clinics query uses amenity/healthcare AND name match', () => {
    const q = buildOverpassQuery('Clínicas', 2000, -25.9, 32.5, 25);
    // amenity clinic|doctors may be grouped as regex when multiple values share key
    assert.match(q, /amenity/);
    assert.match(q, /clinic/);
    assert.match(q, /\["healthcare"="clinic"\]/);
    assert.match(q, /\["name"~/);
    assert.match(q, /around:2000,-25\.9,32\.5/);
    assert.match(q, /out center 25/);
  });

  it('dentists query targets amenity=dentist and name', () => {
    const q = buildOverpassQuery('clínica dentária', 1500, 1, 2, 10);
    assert.match(q, /\["amenity"="dentist"\]/);
    assert.match(q, /\["name"~/);
    assert.match(q, /node\["amenity"="dentist"\]/);
    assert.match(q, /way\["amenity"="dentist"\]/);
    assert.match(q, /relation\["amenity"="dentist"\]/);
  });

  it('beauty query uses shop beauty/hairdresser and name', () => {
    const q = buildOverpassQuery('Salões de beleza', 4000, 0, 0, 15);
    assert.match(q, /shop/);
    assert.match(q, /beauty|hairdresser/);
    assert.match(q, /\["name"~/);
  });

  it('shops category uses key-only shop filter and name', () => {
    const q = buildOverpassQuery('Lojas', 5000, -26, 32, 30);
    assert.match(q, /node\["shop"\]\(around:5000/);
    assert.match(q, /way\["shop"\]\(around:5000/);
    assert.match(q, /relation\["shop"\]\(around:5000/);
    assert.match(q, /\["name"~/);
  });

  it('pharmacy category uses amenity=pharmacy and name', () => {
    const q = buildOverpassQuery('Farmácia', 3000, -25, 32, 20);
    assert.match(q, /\["amenity"="pharmacy"\]/);
    assert.match(q, /\["name"~/);
  });

  it('caps out limit at 100', () => {
    const q = buildOverpassQuery('restaurante', 1000, 0, 0, 500);
    assert.match(q, /out center 100/);
  });

  it('uses bbox when geo.bbox is provided', () => {
    const geo = {
      lat: -25.97,
      lon: 32.57,
      bbox: { south: -26.1, north: -25.8, west: 32.4, east: 32.7 },
    };
    const q = buildOverpassQuery('Restaurantes', 5000, -25.97, 32.57, 20, geo);
    assert.match(q, /\(-26\.1,32\.4,-25\.8,32\.7\)/);
    assert.doesNotMatch(q, /around:/);
  });
});

describe('osmProvider buildOverpassQuery — name fallback', () => {
  it('free-text still uses name regex and commercial keys', () => {
    const q = buildOverpassQuery('padaria central', 2000, -25.9, 32.5, 30);
    assert.match(q, /padaria/i);
    assert.match(q, /\["name"~/);
    assert.match(q, /node\["shop"\]/);
    assert.match(q, /way\["shop"\]/);
    assert.match(q, /node\["amenity"\]/);
    assert.match(q, /way\["amenity"\]/);
    assert.match(q, /way\["office"\]/);
    assert.match(q, /craft/);
    assert.match(q, /tourism/);
    assert.match(q, /around:2000,-25\.9,32\.5/);
    assert.match(q, /out center 30/);
  });

  it('compound category-like phrases fall back to name search', () => {
    const q = buildOverpassQuery('Restaurantes italianos', 2500, 1, 2, 20);
    assert.match(q, /\["name"~/);
    assert.match(q, /italianos/i);
    // Should not resolve as pure category (no bare amenity=restaurant without name)
    // but name search is present
  });

  it('Farmácia Central is free-text name search', () => {
    assert.equal(resolveCategory('Farmácia Central'), null);
    const q = buildOverpassQuery('Farmácia Central', 3000, -25, 32, 15);
    assert.match(q, /\["name"~/);
    assert.match(q, /Farmácia Central|Farm\\xe1cia Central|Farmácia/i);
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
    assert.equal(item.externalId, 'node/42');
    assert.equal(item.lng, 32.5);
    assert.equal(item.rating, null);
    assert.equal(item.reviewsCount, null);
  });
});

describe('osmProvider endpoints and helpers', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('resolveOverpassEndpoints uses OSM_OVERPASS_URL when set', () => {
    process.env.OSM_OVERPASS_URL = 'https://custom.example/api/interpreter';
    const eps = resolveOverpassEndpoints();
    assert.deepEqual(eps, ['https://custom.example/api/interpreter']);
  });

  it('resolveOverpassEndpoints returns defaults when unset', () => {
    delete process.env.OSM_OVERPASS_URL;
    const eps = resolveOverpassEndpoints();
    assert.ok(eps.length >= 2);
    assert.ok(eps.some((e) => e.includes('overpass-api.de')));
  });

  it('extractRemarkError detects error remarks', () => {
    assert.ok(extractRemarkError({ remark: 'runtime error: Query timed out' }));
    assert.equal(extractRemarkError({ remark: 'info: something' }), null);
    assert.equal(extractRemarkError({}), null);
  });

  it('isTransientError recognises 429/502/timeouts', () => {
    assert.equal(isTransientError({ code: 'HTTP_ERROR', httpStatus: 502 }), true);
    assert.equal(isTransientError({ code: 'HTTP_ERROR', httpStatus: 429 }), true);
    assert.equal(isTransientError({ code: 'ECONNRESET' }), true);
    assert.equal(isTransientError({ code: 'PROVIDER_TIMEOUT' }), true);
    assert.equal(isTransientError({ code: 'HTTP_ERROR', httpStatus: 400 }), false);
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

  it('Overpass HTTP 502 after successful geocode → overpass stage (may try fallback)', async () => {
    delete process.env.OSM_DISABLED;
    delete process.env.OSM_OVERPASS_URL;
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
    // At least geocode + one overpass; with multi-endpoint may be more
    assert.ok(calls >= 2);
  });

  it('fallback succeeds on second Overpass endpoint after 502', async () => {
    delete process.env.OSM_DISABLED;
    delete process.env.OSM_OVERPASS_URL;
    let overpassCalls = 0;
    mockFetch(async (url, init) => {
      if (!init || init.method !== 'POST') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{ lat: '-25.97', lon: '32.57', boundingbox: ['-26.1', '-25.8', '32.4', '32.7'] }];
          },
        };
      }
      overpassCalls += 1;
      if (overpassCalls === 1) {
        return { ok: false, status: 502, async json() { return {}; }, async text() { return ''; } };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            elements: [
              {
                type: 'node',
                id: 1,
                lat: -25.97,
                lon: 32.57,
                tags: { name: 'Restaurante Teste', amenity: 'restaurant' },
              },
            ],
          };
        },
      };
    });
    const r = await search({ query: 'Restaurantes', location: 'Maputo', limit: 10 });
    assert.equal(r.status, 'ok');
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].name, 'Restaurante Teste');
    assert.ok(overpassCalls >= 2);
  });

  it('does not fallback on HTTP 400', async () => {
    delete process.env.OSM_DISABLED;
    delete process.env.OSM_OVERPASS_URL;
    let overpassCalls = 0;
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
      overpassCalls += 1;
      return { ok: false, status: 400, async json() { return {}; }, async text() { return 'bad query'; } };
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'HTTP_ERROR');
    assert.equal(r.httpStatus, 400);
    assert.equal(r.errorStage, 'overpass');
    assert.equal(overpassCalls, 1);
  });

  it('valid response with zero elements is empty, not error', async () => {
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
      return {
        ok: true,
        status: 200,
        async json() {
          return { elements: [] };
        },
      };
    });
    const r = await search({ query: 'xyznonexistent', location: 'Maputo', limit: 10 });
    assert.equal(r.status, 'empty');
    assert.equal(r.results.length, 0);
    assert.equal(r.errorCode, null);
  });

  it('invalid JSON from Overpass is error', async () => {
    delete process.env.OSM_DISABLED;
    process.env.OSM_OVERPASS_URL = 'https://single.example/api';
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
      return {
        ok: true,
        status: 200,
        async json() {
          throw new SyntaxError('Unexpected token');
        },
      };
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorStage, 'overpass');
    assert.ok(['OSM_INVALID_JSON', 'PROVIDER_ERROR'].includes(r.errorCode));
  });

  it('response without elements array is error', async () => {
    delete process.env.OSM_DISABLED;
    process.env.OSM_OVERPASS_URL = 'https://single.example/api';
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
      return {
        ok: true,
        status: 200,
        async json() {
          return { remark: null };
        },
      };
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'OSM_INVALID_BODY');
    assert.equal(r.errorStage, 'overpass');
  });

  it('response with error remark is treated as failure', async () => {
    delete process.env.OSM_DISABLED;
    process.env.OSM_OVERPASS_URL = 'https://single.example/api';
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
      return {
        ok: true,
        status: 200,
        async json() {
          return { remark: 'runtime error: Query timed out in ...', elements: [] };
        },
      };
    });
    const r = await search({ query: 'x', location: 'y', limit: 5 });
    assert.equal(r.status, 'error');
    assert.equal(r.errorCode, 'OSM_REMARK');
    assert.equal(r.errorStage, 'overpass');
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
    process.env.OSM_OVERPASS_URL = 'https://single.example/api';
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
    process.env.OSM_OVERPASS_URL = 'https://single.example/api';
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
    process.env.OSM_OVERPASS_URL = 'https://single.example/api';
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
    process.env.OSM_OVERPASS_URL = 'https://single.example/api';
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

  it('preserves result contract fields on successful search', async () => {
    delete process.env.OSM_DISABLED;
    process.env.OSM_OVERPASS_URL = 'https://single.example/api';
    mockFetch(async (url, init) => {
      if (!init || init.method !== 'POST') {
        return {
          ok: true,
          status: 200,
          async json() {
            return [{ lat: '-25.97', lon: '32.57' }];
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            elements: [
              {
                type: 'node',
                id: 99,
                lat: -25.97,
                lon: 32.57,
                tags: {
                  name: 'Farmácia Central',
                  amenity: 'pharmacy',
                  phone: '+258123',
                  'addr:street': 'Av. Principal',
                },
              },
            ],
          };
        },
      };
    });
    const r = await search({ query: 'Farmácia Central', location: 'Maputo', limit: 5 });
    assert.equal(r.status, 'ok');
    assert.equal(r.results.length, 1);
    const lead = r.results[0];
    assert.equal(lead.name, 'Farmácia Central');
    assert.ok(lead.address);
    assert.equal(lead.phone, '+258123');
    assert.equal(lead.sourceProvider, 'osm');
    assert.equal(lead.externalId, 'node/99');
    assert.equal(lead.lat, -25.97);
    assert.equal(lead.lng, 32.57);
    assert.equal(lead.rating, null);
    assert.equal(lead.reviewsCount, null);
    assert.ok(lead.raw);
  });

  it('deduplicates same element found by name and tags', async () => {
    delete process.env.OSM_DISABLED;
    process.env.OSM_OVERPASS_URL = 'https://single.example/api';
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
      return {
        ok: true,
        status: 200,
        async json() {
          // Same element appears twice (as if matched by tag and by name)
          return {
            elements: [
              {
                type: 'node',
                id: 7,
                lat: 1,
                lon: 2,
                tags: { name: 'O Sabor', amenity: 'restaurant' },
              },
              {
                type: 'node',
                id: 7,
                lat: 1,
                lon: 2,
                tags: { name: 'O Sabor', amenity: 'restaurant' },
              },
            ],
          };
        },
      };
    });
    const r = await search({ query: 'Restaurantes', location: 'x', limit: 10 });
    assert.equal(r.status, 'ok');
    assert.equal(r.results.length, 1);
  });
});
