/**
 * Change-password route guards and UI contract helpers.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
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

  async function getCsrf() {
    const res = await fetch(`${base}/api/auth/csrf`);
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

describe('frontend account UI contract', () => {
  const root = path.join(__dirname, '..');

  it('index.html includes settings view and auth groups', () => {
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    assert.match(html, /data-view="settings"/);
    assert.match(html, /id="view-settings"/);
    assert.match(html, /id="guest-actions"/);
    assert.match(html, /id="user-actions"/);
    assert.match(html, /id="change-password-form"/);
    assert.match(html, /id="current-password"/);
    assert.match(html, /id="new-password"/);
    assert.match(html, /id="new-password-confirm"/);
  });

  it('app.js wires settings navigation and change-password API', () => {
    const js = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.match(js, /settings:\s*'Configurações'/);
    assert.match(js, /setGuestUi/);
    assert.match(js, /setAuthedUi/);
    assert.match(js, /setAuthErrorUi/);
    assert.match(js, /\/api\/auth\/change-password/);
    assert.match(js, /loadSettings/);
  });

  it('main.css includes settings and extended breakpoints', () => {
    const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');
    assert.match(css, /\.settings-card/);
    assert.match(css, /\.password-field/);
    assert.match(css, /@media \(max-width: 360px\)/);
    assert.match(css, /@media \(max-width: 1024px\)/);
    assert.match(css, /overflow-x:\s*hidden/);
  });
});
