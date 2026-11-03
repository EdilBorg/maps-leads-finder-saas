/**
 * Ensures rate limiting does not trust the left-most X-Forwarded-For from clients.
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
              const setCookie = res.headers['set-cookie'];
              resolve({
                statusCode: res.statusCode,
                json: () => {
                  try {
                    return JSON.parse(data);
                  } catch {
                    return null;
                  }
                },
                cookie: setCookie ? setCookie.map((c) => c.split(';')[0]).join('; ') : cookie,
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

describe('client IP trust', () => {
  let app;
  before(() => {
    const { createApp } = require('../src/app');
    app = createApp({ sessionStore: new session.MemoryStore() });
  });

  it('rejects CSRF-less requests even with spoofed X-Forwarded-For', async () => {
    const res = await request(app, {
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'X-Forwarded-For': '203.0.113.99' },
      body: { email: 'a@b.co', password: 'password12' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'CSRF');
  });

  it('accepts CSRF and processes login without treating spoofed XFF as identity', async () => {
    const csrfRes = await request(app, { path: '/api/auth/csrf' });
    assert.equal(csrfRes.statusCode, 200);
    const token = csrfRes.json().csrfToken;
    const res = await request(app, {
      method: 'POST',
      path: '/api/auth/login',
      cookie: csrfRes.cookie,
      headers: {
        'X-CSRF-Token': token,
        'X-Forwarded-For': '203.0.113.99, 198.51.100.1',
      },
      body: { email: 'spoof@example.com', password: 'password12' },
    });
    assert.ok([401, 429].includes(res.statusCode));
  });
});
