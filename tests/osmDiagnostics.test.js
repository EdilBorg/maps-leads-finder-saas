/**
 * OSM connectivity diagnostics — unit + route guards.
 * Uses mocked fetch; does not call real OSM services.
 */

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const session = require('express-session');

const {
  runOsmConnectivityDiagnostic,
  probeNominatim,
  probeOverpass,
  fetchWithTimeout,
} = require('../src/services/osmDiagnostics');
const { requireAdmin } = require('../src/middleware/auth');
const authService = require('../src/services/authService');

const ORIGINAL_FETCH = global.fetch;

function mockFetch(handler) {
  global.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url.includes('127.0.0.1') || url.includes('localhost')) {
      return ORIGINAL_FETCH(input, init);
    }
    return handler(url, init, input);
  };
}

function restoreFetch() {
  global.fetch = ORIGINAL_FETCH;
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

describe('osmDiagnostics service classification', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('classifies successful nominatim as reachable', async () => {
    mockFetch(async () => jsonResponse(200, [{ lat: '38.7', lon: '-9.1' }]));
    const r = await probeNominatim();
    assert.equal(r.status, 'reachable');
    assert.equal(r.httpStatus, 200);
    assert.equal(r.errorCode, null);
  });

  it('classifies HTTP 502 as http_error with httpStatus 502', async () => {
    mockFetch(async () => jsonResponse(502, { error: 'overload' }));
    const r = await probeOverpass('overpass_primary', 'https://overpass-api.de/api/interpreter');
    assert.equal(r.status, 'http_error');
    assert.equal(r.httpStatus, 502);
    assert.equal(r.errorCode, 'HTTP_ERROR');
  });

  it('classifies ECONNREFUSED as network_error', async () => {
    mockFetch(async () => {
      const cause = new Error('connect ECONNREFUSED');
      cause.code = 'ECONNREFUSED';
      const err = new TypeError('fetch failed');
      err.cause = cause;
      throw err;
    });
    const r = await probeOverpass('overpass_primary', 'https://overpass-api.de/api/interpreter');
    assert.equal(r.status, 'network_error');
    assert.equal(r.errorCode, 'ECONNREFUSED');
    assert.equal(r.errorName, 'TypeError');
    assert.equal(r.causeCode, 'ECONNREFUSED');
    assert.equal(r.httpStatus, null);
  });

  it('classifies timeout and aborts the call', async () => {
    let aborted = false;
    mockFetch(async (_url, opts) => {
      return new Promise((resolve, reject) => {
        const signal = opts && opts.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            aborted = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });
    await assert.rejects(
      () => fetchWithTimeout('https://example.test', {}, 40),
      (err) => err.code === 'DIAGNOSTIC_TIMEOUT' || err.name === 'TimeoutError'
    );
    assert.equal(aborted, true);
  });

  it('timeout status from probe after AbortError', async () => {
    mockFetch(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const r = await probeNominatim();
    assert.equal(r.status, 'timeout');
    assert.equal(r.errorCode, 'DIAGNOSTIC_TIMEOUT');
  });

  it('invalid JSON body → invalid_response', async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError('Unexpected token');
      },
    }));
    const r = await probeNominatim();
    assert.equal(r.status, 'invalid_response');
    assert.equal(r.httpStatus, 200);
  });

  it('continues sequential probes when nominatim fails', async () => {
    let calls = 0;
    mockFetch(async (url, init) => {
      calls += 1;
      const u = String(url);
      if (u.includes('nominatim')) {
        const cause = new Error('refused');
        cause.code = 'ECONNREFUSED';
        const err = new TypeError('fetch failed');
        err.cause = cause;
        throw err;
      }
      if (init && init.method === 'POST') {
        return jsonResponse(200, { version: 0.6, elements: [] });
      }
      return jsonResponse(200, []);
    });
    const payload = await runOsmConnectivityDiagnostic();
    assert.equal(payload.diagnostic, 'osm_connectivity');
    assert.equal(payload.results.length, 3);
    assert.equal(payload.results[0].target, 'nominatim');
    assert.equal(payload.results[0].status, 'network_error');
    assert.equal(payload.results[1].target, 'overpass_primary');
    assert.equal(payload.results[1].status, 'reachable');
    assert.equal(payload.results[2].target, 'overpass_alternative');
    assert.equal(payload.results[2].status, 'reachable');
    assert.ok(calls >= 3);
  });

  it('primary overpass failure still probes alternative', async () => {
    mockFetch(async (url) => {
      const u = String(url);
      if (u.includes('nominatim')) {
        return jsonResponse(200, [{ lat: '1', lon: '2' }]);
      }
      if (u.includes('overpass-api.de')) {
        const cause = new Error('refused');
        cause.code = 'ECONNREFUSED';
        const err = new TypeError('fetch failed');
        err.cause = cause;
        throw err;
      }
      return jsonResponse(200, { elements: [] });
    });
    const payload = await runOsmConnectivityDiagnostic();
    assert.equal(payload.results[1].status, 'network_error');
    assert.equal(payload.results[1].errorCode, 'ECONNREFUSED');
    assert.equal(payload.results[2].status, 'reachable');
  });

  it('response does not include sensitive fields', async () => {
    mockFetch(async () => {
      const cause = new Error('secret-host.internal:443 connect failed password=xyz');
      cause.code = 'ECONNREFUSED';
      const err = new TypeError('fetch failed');
      err.cause = cause;
      err.stack = 'Error: secret\n    at secret';
      throw err;
    });
    const payload = await runOsmConnectivityDiagnostic();
    const raw = JSON.stringify(payload);
    assert.ok(!/password=/i.test(raw));
    assert.ok(!/stack/i.test(raw));
    assert.ok(!/secret-host/i.test(raw));
    for (const r of payload.results) {
      assert.equal(Object.prototype.hasOwnProperty.call(r, 'message'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(r, 'stack'), false);
    }
  });
});

describe('requireAdmin middleware', () => {
  function run(mw, req) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          this.body = payload;
          resolve({ statusCode: this.statusCode, body: payload });
          return this;
        },
      };
      mw(req, res, () => resolve({ statusCode: 200, body: null, next: true }));
    });
  }

  it('401 when not authenticated', async () => {
    const r = await run(requireAdmin, { session: null, user: null });
    assert.equal(r.statusCode, 401);
  });

  it('403 when authenticated non-admin', async () => {
    const r = await run(requireAdmin, {
      session: { userId: 'u1' },
      user: { role: 'user', emailVerified: true },
    });
    assert.equal(r.statusCode, 403);
  });

  it('403 when admin but email not verified', async () => {
    const r = await run(requireAdmin, {
      session: { userId: 'u1' },
      user: { role: 'admin', emailVerified: false },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.code, 'EMAIL_NOT_VERIFIED');
  });

  it('allows admin with verified email', async () => {
    const r = await run(requireAdmin, {
      session: { userId: 'u1' },
      user: { role: 'admin', emailVerified: true },
    });
    assert.equal(r.next, true);
  });
});

describe('GET /api/admin/diagnostics/osm route', () => {
  let server;
  let base;
  let store;
  const originalFind = authService.findUserById;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-min-16chars';
    store = new session.MemoryStore();
    const { createApp } = require('../src/app');
    const app = createApp({ sessionStore: store });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    authService.findUserById = originalFind;
    restoreFetch();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  afterEach(() => {
    authService.findUserById = originalFind;
    restoreFetch();
  });

  async function getSessionCookie() {
    const res = await fetch(`${base}/api/auth/csrf`);
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    return (setCookie || []).map((c) => c.split(';')[0]).join('; ');
  }

  function sidFromCookie(cookieHeader) {
    const part = cookieHeader
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('mlf.sid='));
    if (!part) return null;
    let raw = decodeURIComponent(part.slice('mlf.sid='.length));
    if (raw.startsWith('s:')) raw = raw.slice(2);
    const dot = raw.indexOf('.');
    return dot >= 0 ? raw.slice(0, dot) : raw;
  }

  async function setSessionUser(cookie, userRow) {
    const sid = sidFromCookie(cookie);
    assert.ok(sid, 'session id present');
    await new Promise((resolve, reject) => {
      store.get(sid, (err, sess) => {
        if (err) return reject(err);
        const next = sess || {};
        next.userId = userRow.id;
        next.emailVerified = Boolean(userRow.email_verified_at);
        store.set(sid, next, (e) => (e ? reject(e) : resolve()));
      });
    });
    authService.findUserById = async () => userRow;
  }

  it('401 for unauthenticated client', async () => {
    const res = await fetch(`${base}/api/admin/diagnostics/osm`);
    assert.equal(res.status, 401);
  });

  it('403 for common verified user', async () => {
    const cookie = await getSessionCookie();
    await setSessionUser(cookie, {
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      role: 'user',
      status: 'active',
      email_verified_at: new Date(),
    });
    const res = await fetch(`${base}/api/admin/diagnostics/osm`, {
      headers: { cookie },
    });
    assert.equal(res.status, 403);
  });

  it('200 for admin and runs sequential probes with mocks', async () => {
    const cookie = await getSessionCookie();
    await setSessionUser(cookie, {
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Admin',
      role: 'admin',
      status: 'active',
      email_verified_at: new Date(),
    });
    mockFetch(async (url) => {
      const u = String(url);
      assert.ok(
        u.includes('nominatim.openstreetmap.org') ||
          u.includes('overpass-api.de') ||
          u.includes('overpass.kumi.systems'),
        'unexpected host: ' + u
      );
      if (u.includes('nominatim')) return jsonResponse(200, [{ lat: '1', lon: '2' }]);
      return jsonResponse(200, { elements: [] });
    });
    const res = await fetch(`${base}/api/admin/diagnostics/osm`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.diagnostic, 'osm_connectivity');
    assert.equal(body.results.length, 3);
    assert.ok(!JSON.stringify(body).includes('stack'));
  });

  it('does not accept arbitrary URL query parameters for SSRF', async () => {
    const cookie = await getSessionCookie();
    await setSessionUser(cookie, {
      id: 'admin-2',
      email: 'admin2@example.com',
      name: 'Admin',
      role: 'admin',
      status: 'active',
      email_verified_at: new Date(),
    });
    const seen = [];
    mockFetch(async (url) => {
      const u = String(url);
      seen.push(u);
      assert.ok(!u.includes('evil.example'), 'SSRF target must not be fetched');
      if (u.includes('nominatim')) return jsonResponse(200, [{ lat: '1', lon: '2' }]);
      return jsonResponse(200, { elements: [] });
    });
    const res = await fetch(`${base}/api/admin/diagnostics/osm?url=http://evil.example/steal`, {
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    assert.ok(seen.length >= 1);
  });
});
