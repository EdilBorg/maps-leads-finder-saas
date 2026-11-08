/**
 * Auth behavioural tests.
 * - Always: CSRF middleware behaviour (MemoryStore).
 * - With ALLOW_DB_TESTS=1 and a dedicated *_test database: full integration.
 */

require('dotenv').config();
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const session = require('express-session');

const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');
const { clearAuthTestState } = require('./helpers/clearAuthTestState');
const hasDb = shouldRunDbIntegration();

function request(app, { method = 'GET', path, body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body !== undefined ? JSON.stringify(body) : null;
      const reqHeaders = {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      };
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method, headers: reqHeaders },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            server.close(() => {
              const setCookie = res.headers['set-cookie'];
              const cookieStr = setCookie
                ? setCookie.map((c) => c.split(';')[0]).join('; ')
                : cookie;
              resolve({
                statusCode: res.statusCode,
                body: data,
                json: () => {
                  try { return JSON.parse(data); } catch { return null; }
                },
                cookie: cookieStr,
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

async function getCsrf(app, cookie) {
  const res = await request(app, { path: '/api/auth/csrf', cookie });
  assert.equal(res.statusCode, 200);
  const token = res.json().csrfToken;
  assert.ok(token && token.length > 10);
  return { token, cookie: res.cookie };
}

describe('CSRF protection', () => {
  let app;
  before(() => {
    const { createApp } = require('../src/app');
    app = createApp({ sessionStore: new session.MemoryStore() });
  });

  it('issues a CSRF token', async () => {
    const { token, cookie } = await getCsrf(app);
    assert.ok(token);
    assert.ok(cookie);
  });

  it('rejects state-changing request without CSRF token', async () => {
    const { cookie } = await getCsrf(app);
    const res = await request(app, {
      method: 'POST',
      path: '/api/auth/login',
      cookie,
      body: { email: 'a@b.co', password: 'password1' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'CSRF');
  });

  it('rejects invalid CSRF token', async () => {
    const { cookie } = await getCsrf(app);
    const res = await request(app, {
      method: 'POST',
      path: '/api/auth/login',
      cookie,
      headers: { 'X-CSRF-Token': 'totally-wrong-token-value-here' },
      body: { email: 'a@b.co', password: 'password1' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().code, 'CSRF');
  });
});

describe('auth integration', { skip: !hasDb }, () => {
  let createApp;
  let getPool;
  let closePool;
  let app;
  let resetRateLimits;
  const suffix = `${Date.now()}`;
  const email = `audit_${suffix}@example.com`;
  const password = 'test-password-9';

  before(async () => {
    assertSafeTestDatabase();
    ({ createApp } = require('../src/app'));
    ({ getPool, closePool } = require('../src/db/pool'));
    ({ resetRateLimits } = require('../src/middleware/rateLimit'));
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_auth.sql'), 'utf8');
    await getPool().query(sql);
    app = createApp({ sessionStore: new session.MemoryStore() });
    await clearAuthTestState({ emails: [email] });
  });

  beforeEach(async () => {
    if (resetRateLimits) resetRateLimits();
    try {
      await clearAuthTestState({ emails: [email, `ratelimit_${suffix}@example.com`, `short_${suffix}@example.com`] });
    } catch (_) {
      /* unit path without DB */
    }
  });

  after(async () => {
    try {
      await clearAuthTestState({ emails: [email, `ratelimit_${suffix}@example.com`] });
    } catch (_) {}
    try {
      await getPool().query('DELETE FROM users WHERE email_normalized LIKE $1', [
        `%${suffix}@example.com`,
      ]);
    } catch (_) {}
    try { await closePool(); } catch (_) {}
  });

  async function post(path, body, cookie) {
    const csrf = await getCsrf(app, cookie);
    return request(app, {
      method: 'POST',
      path,
      body,
      cookie: csrf.cookie,
      headers: { 'X-CSRF-Token': csrf.token },
    });
  }

  it('registers a valid user', async () => {
    const res = await post('/api/auth/register', {
      name: 'Audit User',
      email,
      password,
      passwordConfirm: password,
    });
    assert.equal(res.statusCode, 201);
    const data = res.json();
    assert.ok(data.user);
    assert.equal(data.user.emailVerified, false);
    assert.equal(data.user.role, 'user');
    assert.ok('emailSent' in data);
  });

  it('rejects duplicate email', async () => {
    const res = await post('/api/auth/register', {
      name: 'Other',
      email,
      password,
      passwordConfirm: password,
    });
    assert.equal(res.statusCode, 409);
  });

  it('rejects invalid password', async () => {
    const res = await post('/api/auth/register', {
      name: 'X',
      email: `short_${suffix}@example.com`,
      password: 'short',
      passwordConfirm: 'short',
    });
    assert.equal(res.statusCode, 400);
  });

  it('logs in with valid credentials', async () => {
    const res = await post('/api/auth/login', { email, password });
    assert.equal(res.statusCode, 200);
    assert.ok(res.cookie);
    assert.ok(res.json().user);
  });

  it('rejects invalid credentials', async () => {
    const res = await post('/api/auth/login', { email, password: 'wrong-password-xx' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error, 'Credenciais inválidas.');
  });

  it('rejects unauthenticated /me', async () => {
    const res = await request(app, { path: '/api/auth/me' });
    assert.equal(res.statusCode, 401);
  });

  it('allows /me with session and logout invalidates', async () => {
    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookie;
    const me = await request(app, { path: '/api/auth/me', cookie });
    assert.equal(me.statusCode, 200);
    const logout = await post('/api/auth/logout', {}, cookie);
    assert.equal(logout.statusCode, 200);
    const me2 = await request(app, { path: '/api/auth/me', cookie });
    assert.equal(me2.statusCode, 401);
  });

  it('verifies email with valid token and rejects reuse', async () => {
    const crypto = require('../src/utils/crypto');
    const raw = crypto.generateToken();
    const hash = crypto.hashToken(raw);
    await getPool().query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       SELECT id, $1, NOW() + interval '1 hour' FROM users WHERE email_normalized = $2`,
      [hash, email.toLowerCase()]
    );
    const res = await post('/api/auth/verify-email', { token: raw });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user.emailVerified, true);
    const reuse = await post('/api/auth/verify-email', { token: raw });
    assert.equal(reuse.statusCode, 400);
    assert.equal(reuse.json().code, 'TOKEN_USED');
  });

  it('rejects expired verification token', async () => {
    const crypto = require('../src/utils/crypto');
    const raw = crypto.generateToken();
    const hash = crypto.hashToken(raw);
    await getPool().query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       SELECT id, $1, NOW() - interval '1 hour' FROM users WHERE email_normalized = $2`,
      [hash, email.toLowerCase()]
    );
    const res = await post('/api/auth/verify-email', { token: raw });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'TOKEN_EXPIRED');
  });

  it('password reset updates password and revokes sessions', async () => {
    const crypto = require('../src/utils/crypto');
    const raw = crypto.generateToken();
    const hash = crypto.hashToken(raw);
    const { rows } = await getPool().query(
      `SELECT id FROM users WHERE email_normalized = $1`,
      [email.toLowerCase()]
    );
    await getPool().query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + interval '1 hour')`,
      [rows[0].id, hash]
    );
    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.statusCode, 200);
    const newPass = 'new-password-42';
    const reset = await post('/api/auth/reset-password', {
      token: raw,
      password: newPass,
      passwordConfirm: newPass,
    });
    assert.equal(reset.statusCode, 200);
    const bad = await post('/api/auth/login', { email, password });
    assert.equal(bad.statusCode, 401);
    const good = await post('/api/auth/login', { email, password: newPass });
    assert.equal(good.statusCode, 200);
  });

  it('forgot-password is neutral for unknown emails', async () => {
    const res = await post('/api/auth/forgot-password', {
      email: 'nobody-exists-xyz@example.com',
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().message);
  });

  it('rate-limits repeated failed logins by email', async () => {
    const target = `ratelimit_${suffix}@example.com`;
    await post('/api/auth/register', {
      name: 'RL',
      email: target,
      password: 'password99',
      passwordConfirm: 'password99',
    });
    let limited = false;
    for (let i = 0; i < 8; i++) {
      const res = await post('/api/auth/login', { email: target, password: 'wrong-pass' });
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    assert.equal(limited, true);
  });
});
