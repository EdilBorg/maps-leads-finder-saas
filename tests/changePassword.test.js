/**
 * Change-password route guards (no DB required for unauthenticated paths).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');

describe('change-password route guards', () => {
  let server;
  let base;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-min-16chars';
    const app = createApp({
      sessionStore: new (require('express-session').MemoryStore)(),
    });
    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function getCsrf(cookieJar) {
    const res = await fetch(`${base}/api/auth/csrf`, {
      headers: cookieJar ? { cookie: cookieJar } : {},
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const data = await res.json();
    return { token: data.csrfToken, setCookie };
  }

  it('rejects unauthenticated change-password with 401', async () => {
    const { token, setCookie } = await getCsrf();
    const cookie = (setCookie || []).map((c) => c.split(';')[0]).join('; ');
    const res = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
        cookie,
      },
      body: JSON.stringify({
        currentPassword: 'oldpass12',
        newPassword: 'newpass123',
        newPasswordConfirm: 'newpass123',
      }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects change-password without CSRF when unauthenticated', async () => {
    const res = await fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'oldpass12',
        newPassword: 'newpass123',
        newPasswordConfirm: 'newpass123',
      }),
    });
    assert.ok(res.status === 403 || res.status === 401);
  });
});
