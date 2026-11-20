/**
 * Bright Data provider — unit tests with mocked fetch (no network).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const provider = require('../src/services/providers/brightDataProvider');

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

function mockFetchSequence(handlers) {
  let i = 0;
  global.fetch = async (url, opts) => {
    if (i >= handlers.length) {
      throw new Error('Unexpected fetch: ' + url);
    }
    const h = handlers[i++];
    return h(String(url), opts || {});
  };
  return () => {
    assert.equal(i, handlers.length, 'not all fetch handlers consumed');
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

describe('brightDataProvider — configuration', () => {
  beforeEach(() => {
    delete process.env.BRIGHTDATA_API_KEY;
    delete process.env.TOMTOM_API_KEY;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('isConfigured is false without key', () => {
    assert.equal(provider.isConfigured(), false);
  });

  it('isConfigured is true with key', () => {
    process.env.BRIGHTDATA_API_KEY = 'test-key-12345678';
    assert.equal(provider.isConfigured(), true);
  });

  it('search returns not_configured without key', async () => {
    const res = await provider.search({ query: 'clinicas', location: 'Maputo' });
    assert.equal(res.status, 'not_configured');
    assert.deepEqual(res.results, []);
  });
});

describe('brightDataProvider — mapItem', () => {
  it('maps documented fields to internal lead shape', () => {
    const item = provider.mapItem(
      {
        place_id: 'ChIJabc',
        name: 'Café Central',
        address: 'Av. Julius Nyerere, Maputo',
        phone_number: '+25884000000',
        open_website: 'https://example.com',
        rating: 4.5,
        reviews_count: 12,
        category: 'Cafe',
        lat: -25.96,
        lon: 32.57,
        main_image: 'https://img.example/1.jpg',
        url: 'https://maps.google.com/?cid=1',
        country: 'Mozambique',
      },
      0
    );
    assert.equal(item.name, 'Café Central');
    assert.equal(item.phone, '+25884000000');
    assert.equal(item.website, 'https://example.com');
    assert.equal(item.rating, 4.5);
    assert.equal(item.reviewsCount, 12);
    assert.equal(item.lat, -25.96);
    assert.equal(item.lng, 32.57);
    assert.equal(item.photoUrl, 'https://img.example/1.jpg');
    assert.equal(item.googleMapsUrl, 'https://maps.google.com/?cid=1');
    assert.equal(item.sourceProvider, 'brightdata');
    assert.equal(item.externalId, 'ChIJabc');
    assert.equal(item.email, null);
    assert.ok(item.raw);
  });

  it('returns null without name', () => {
    assert.equal(provider.mapItem({ place_id: 'x' }, 0), null);
  });

  it('handles missing optional fields as null', () => {
    const item = provider.mapItem({ name: 'Only Name' }, 3);
    assert.equal(item.phone, null);
    assert.equal(item.website, null);
    assert.equal(item.rating, null);
    assert.equal(item.lat, null);
    assert.equal(item.lng, null);
    assert.equal(item.externalId, null);
  });
});

describe('brightDataProvider — buildInput', () => {
  it('builds discover_by location body', () => {
    const { body, limit } = provider.buildInput(
      { query: 'Restaurants', limit: 80 },
      { lat: -25.9, lng: 32.5, country: 'MZ' }
    );
    assert.equal(limit, 80);
    assert.equal(body.input[0].country, 'MZ');
    assert.equal(body.input[0].keyword, 'Restaurants');
    assert.equal(body.input[0].lat, -25.9);
    assert.equal(body.input[0].long, 32.5);
    assert.equal(body.limit_per_input, 80);
  });
});

describe('brightDataProvider — async flow', () => {
  beforeEach(() => {
    process.env.BRIGHTDATA_API_KEY = 'test-key-12345678';
    process.env.TOMTOM_API_KEY = 'tomtom-test-key-12345';
    process.env.BRIGHTDATA_MAX_WAIT_MS = '5000';
    process.env.BRIGHTDATA_POLL_INTERVAL_MS = '10';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('happy path: geocode → trigger → running → ready → download', async () => {
    const done = mockFetchSequence([
      async () =>
        jsonResponse(200, {
          results: [
            {
              position: { lat: -25.9692, lon: 32.5732 },
              address: { countryCode: 'MZ' },
            },
          ],
        }),
      async (url, opts) => {
        assert.match(url, /\/datasets\/v3\/trigger/);
        assert.match(url, /discover_by=location/);
        assert.equal(opts.method, 'POST');
        assert.match(opts.headers.Authorization, /^Bearer /);
        return jsonResponse(200, { snapshot_id: 'sd_test_1' });
      },
      async (url) => {
        assert.match(url, /\/progress\/sd_test_1/);
        return jsonResponse(200, { status: 'running', snapshot_id: 'sd_test_1' });
      },
      async () => jsonResponse(200, { status: 'ready', snapshot_id: 'sd_test_1' }),
      async (url) => {
        assert.match(url, /\/snapshot\/sd_test_1\?format=json/);
        return jsonResponse(200, [
          {
            place_id: 'ChIJ1',
            name: 'Place A',
            address: 'Addr',
            phone_number: '123',
            lat: -25.9,
            lon: 32.5,
          },
        ]);
      },
    ]);
    const res = await provider.search({ query: 'Restaurants', location: 'Maputo', limit: 50 });
    done();
    assert.equal(res.status, 'ok');
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].name, 'Place A');
    assert.equal(res.results[0].sourceProvider, 'brightdata');
  });

  it('returns error when snapshot_id missing', async () => {
    mockFetchSequence([
      async () =>
        jsonResponse(200, {
          results: [{ position: { lat: 1, lon: 2 }, address: { countryCode: 'US' } }],
        }),
      async () => jsonResponse(200, {}),
    ]);
    const res = await provider.search({ query: 'x', location: 'NY' });
    assert.equal(res.status, 'error');
    assert.equal(res.errorCode, 'INVALID_RESPONSE');
  });

  it('handles snapshot failed', async () => {
    mockFetchSequence([
      async () =>
        jsonResponse(200, {
          results: [{ position: { lat: 1, lon: 2 }, address: { countryCode: 'US' } }],
        }),
      async () => jsonResponse(200, { snapshot_id: 'sd_fail' }),
      async () => jsonResponse(200, { status: 'failed' }),
    ]);
    const res = await provider.search({ query: 'x', location: 'NY' });
    assert.equal(res.status, 'error');
    assert.equal(res.errorCode, 'PROVIDER_ERROR');
  });

  it('empty snapshot yields empty status', async () => {
    mockFetchSequence([
      async () =>
        jsonResponse(200, {
          results: [{ position: { lat: 1, lon: 2 }, address: { countryCode: 'US' } }],
        }),
      async () => jsonResponse(200, { snapshot_id: 'sd_empty' }),
      async () => jsonResponse(200, { status: 'ready' }),
      async () => jsonResponse(200, []),
    ]);
    const res = await provider.search({ query: 'x', location: 'NY' });
    assert.equal(res.status, 'empty');
    assert.deepEqual(res.results, []);
  });

  it('HTTP 401 on trigger', async () => {
    mockFetchSequence([
      async () =>
        jsonResponse(200, {
          results: [{ position: { lat: 1, lon: 2 }, address: { countryCode: 'US' } }],
        }),
      async () => jsonResponse(401, { error: 'unauthorized' }),
    ]);
    const res = await provider.search({ query: 'x', location: 'NY' });
    assert.equal(res.status, 'error');
    assert.equal(res.errorCode, 'AUTH_ERROR');
  });

  it('HTTP 429 on trigger', async () => {
    mockFetchSequence([
      async () =>
        jsonResponse(200, {
          results: [{ position: { lat: 1, lon: 2 }, address: { countryCode: 'US' } }],
        }),
      async () => jsonResponse(429, { error: 'rate' }),
    ]);
    const res = await provider.search({ query: 'x', location: 'NY' });
    assert.equal(res.status, 'error');
    assert.equal(res.errorCode, 'RATE_LIMIT');
  });

  it('HTTP 500 on trigger', async () => {
    mockFetchSequence([
      async () =>
        jsonResponse(200, {
          results: [{ position: { lat: 1, lon: 2 }, address: { countryCode: 'US' } }],
        }),
      async () => jsonResponse(500, 'server error'),
    ]);
    const res = await provider.search({ query: 'x', location: 'NY' });
    assert.equal(res.status, 'error');
    assert.equal(res.errorCode, 'HTTP_ERROR');
  });

  it('GEOCODE_FAILED when location not found', async () => {
    mockFetchSequence([async () => jsonResponse(200, { results: [] })]);
    const res = await provider.search({ query: 'x', location: 'NowhereXYZ' });
    assert.equal(res.status, 'error');
    assert.equal(res.errorCode, 'GEOCODE_FAILED');
  });

  it('cancels during polling and does not download snapshot', async () => {
    const ac = new AbortController();
    let downloadCalled = false;
    mockFetchSequence([
      async () =>
        jsonResponse(200, {
          results: [{ position: { lat: 1, lon: 2 }, address: { countryCode: 'US' } }],
        }),
      async () => jsonResponse(200, { snapshot_id: 'sd_cancel' }),
      async () => {
        ac.abort();
        return jsonResponse(200, { status: 'running' });
      },
    ]);
    const prev = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url).includes('/snapshot/')) downloadCalled = true;
      return prev(url, opts);
    };
    const res = await provider.search({ query: 'x', location: 'NY' }, ac.signal);
    assert.equal(res.status, 'error');
    assert.equal(res.errorCode, 'CANCELLED');
    assert.equal(downloadCalled, false);
  });

  it('uses explicit lat/lng/country without geocode call', async () => {
    let geocodeCalled = false;
    mockFetchSequence([
      async (url) => {
        if (String(url).includes('tomtom.com')) geocodeCalled = true;
        assert.match(String(url), /\/trigger/);
        return jsonResponse(200, { snapshot_id: 'sd_geo' });
      },
      async () => jsonResponse(200, { status: 'ready' }),
      async () =>
        jsonResponse(200, [{ name: 'P', place_id: 'ChIJ', lat: 10, lon: 20 }]),
    ]);
    const res = await provider.search({
      query: 'cafe',
      location: 'ignored when coords present',
      lat: 40.7,
      lng: -74.0,
      country: 'US',
      limit: 10,
    });
    assert.equal(geocodeCalled, false);
    assert.equal(res.status, 'ok');
    assert.equal(res.results[0].name, 'P');
  });
});

describe('brightDataProvider — resolveSignal', () => {
  it('accepts AbortSignal directly', () => {
    const ac = new AbortController();
    assert.equal(provider.resolveSignal(ac.signal), ac.signal);
  });
  it('accepts opts.signal', () => {
    const ac = new AbortController();
    assert.equal(provider.resolveSignal({ signal: ac.signal }), ac.signal);
  });
});
