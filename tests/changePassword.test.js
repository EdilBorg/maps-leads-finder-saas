/**
 * Auth recovery UI contract + route guards.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');

describe('change-password route guards (legacy endpoint retained)', () => {
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
});

describe('frontend account UI contract', () => {
  const root = path.join(__dirname, '..');

  it('settings uses email recovery, not direct password fields', () => {
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    assert.match(html, /id="reset-password-panel"/);
    assert.match(html, /id="btn-send-reset-link"/);
    assert.match(html, /id="reset-password-email"/);
    assert.doesNotMatch(html, /id="current-password"/);
    assert.doesNotMatch(html, /id="new-password-confirm"/);
    assert.match(html, /id="guest-actions"/);
    assert.match(html, /id="user-actions"/);
  });

  it('app.js requests forgot-password with authenticated user email', () => {
    const js = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.match(js, /\/api\/auth\/forgot-password/);
    assert.match(js, /currentUser\.email/);
    assert.match(js, /setGuestUi/);
    assert.match(js, /setAuthedUi/);
    assert.doesNotMatch(js, /\/api\/auth\/change-password/);
  });

  it('auth groups respect [hidden] over display:flex', () => {
    const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');
    assert.match(css, /\.topbar-group\[hidden\]/);
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('tables keep min-width and horizontal scroll containers', () => {
    const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    assert.match(css, /overflow-x:\s*auto/);
    assert.match(css, /table-wrap-results[\s\S]*min-width:\s*920px/);
    assert.match(css, /table-wrap-history[\s\S]*min-width:\s*720px/);
    assert.match(css, /table-wrap-leads[\s\S]*min-width:\s*720px/);
    assert.doesNotMatch(css, /table\.data td,\s*table\.data th\s*\{\s*max-width:\s*240px/);
    assert.match(html, /table-wrap-results/);
    assert.match(html, /table-wrap-history/);
    assert.match(html, /table-wrap-leads/);
  });
});
