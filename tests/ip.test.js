/**
 * Trust proxy / req.ip / rate-limit key behaviour.
 * Proves rate limiter key material is req.ip, not client-controlled X-Forwarded-For,
 * when TRUST_PROXY_HOPS=0 (the default).
 */
require('dotenv').config();
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const session = require('express-session');

function request(app, { method = 'GET', path, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body !== undefined ? JSON.stringify(body) : null;
      const reqHeaders = {
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
        ...headers,
      };
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method, headers: reqHeaders },
        (res) => {
          let data = '';
          res.on('data', (c) => {
            data += c;
          });
          res.on('end', () => {
            server.close(() => {
              resolve({
                statusCode: res.statusCode,
                json: () => {
                  try {
                    return JSON.parse(data);
                  } catch {
                    return null;
                  }
                },
              });
            });
          });
        }
      );
      req.on('error', (err) => server.close(() => reject(err)));
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function loadAppWithTrust(hops) {
  process.env.TRUST_PROXY_HOPS = String(hops);
  process.env.ENABLE_TEST_ROUTES = '1';
  if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/app')];
  const { createApp } = require('../src/app');
  return createApp({ sessionStore: new session.MemoryStore() });
}

describe('rate-limit keys use req.ip (TRUST_PROXY_HOPS=0)', () => {
  let app;
  before(() => {
    app = loadAppWithTrust(0);
  });

  it('default trust hops is 0 for these tests', () => {
    assert.equal(process.env.TRUST_PROXY_HOPS, '0');
  });

  it('spoofed X-Forwarded-For does not change req.ip or rate key', async () => {
    const a = await request(app, {
      path: '/__test/rate-key',
      headers: { 'X-Forwarded-For': '203.0.113.10' },
    });
    const b = await request(app, {
      path: '/__test/rate-key',
      headers: { 'X-Forwarded-For': '198.51.100.20' },
    });
    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.notEqual(a.json().ip, '203.0.113.10');
    assert.notEqual(b.json().ip, '198.51.100.20');
    assert.equal(a.json().rateKey, b.json().rateKey);
    assert.match(a.json().rateKey, /^login:/);
  });

  it('rate key is built from req.ip only (login:${ip})', async () => {
    const res = await request(app, {
      path: '/__test/rate-key',
      headers: { 'X-Forwarded-For': '203.0.113.99' },
    });
    assert.equal(res.statusCode, 200);
    const { ip, rateKey } = res.json();
    assert.equal(rateKey, `login:${ip}`);
  });

  it('rejects CSRF-less login even with spoofed XFF', async () => {
    const res = await request(app, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'X-Forwarded-For': '203.0.113.99' },
      body: { email: 'a@b.co', password: 'password12' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'CSRF');
  });
});

describe('TRUST_PROXY_HOPS=1 is not claimed as production-safe', () => {
  let app;
  before(() => {
    app = loadAppWithTrust(1);
  });

  it('endpoint still responds; operators must validate real topology', async () => {
    const res = await request(app, {
      path: '/__test/rate-key',
      headers: { 'X-Forwarded-For': '203.0.113.50' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().rateKey.startsWith('login:');
  });
});
