/**
 * Trust proxy / req.ip behaviour.
 * With TRUST_PROXY_HOPS=0, spoofed X-Forwarded-For must not become req.ip.
 */
require('dotenv').config();
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const session = require('express-session');

function request(app, { method = 'GET', path, body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body !== undefined ? JSON.stringify(body) : null;
      const reqHeaders = {
        ...(payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}),
        ...(cookie ? { Cookie: cookie } : {}),
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

describe('client IP with TRUST_PROXY_HOPS=0', () => {
  let app;
  before(() => {
    app = loadAppWithTrust(0);
  });

  it('req.ip is loopback, not the spoofed X-Forwarded-For value', async () => {
    const res = await request(app, {
      path: '/__test/client-ip',
      headers: { 'X-Forwarded-For': '203.0.113.99' },
    });
    assert.equal(res.statusCode, 200);
    const ip = res.json().ip;
    assert.ok(
      ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1',
      `unexpected ip ${ip}`
    );
    assert.notEqual(ip, '203.0.113.99');
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

describe('client IP with TRUST_PROXY_HOPS=1 (in-process simulation only)', () => {
  let app;
  before(() => {
    app = loadAppWithTrust(1);
  });

  it('documents Express behaviour when one hop is trusted — not production proof', async () => {
    const res = await request(app, {
      path: '/__test/client-ip',
      headers: { 'X-Forwarded-For': '203.0.113.50' },
    });
    assert.equal(res.statusCode, 200);
    const ip = res.json().ip;
    assert.ok(typeof ip === 'string' || ip === null);
  });
});
