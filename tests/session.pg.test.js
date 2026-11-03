/**
 * Integration: connect-pg-simple session persistence against real PostgreSQL.
 * Skipped when DATABASE_URL is not set.
 *
 * Proves sessions survive app recreate (new createApp instance) using the same store.
 */
require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);

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
                cookie: setCookie
                  ? setCookie.map((c) => c.split(';')[0]).join('; ')
                  : cookie,
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

describe('PostgreSQL session store (connect-pg-simple)', { skip: !hasDb }, () => {
  let createApp;
  let getPool;
  let closePool;
  let store;
  let app;
  const suffix = `${Date.now()}`;
  const email = `sess_${suffix}@example.com`;
  const password = 'session-pass-99';

  async function getCsrf(cookie) {
    const res = await request(app, { path: '/api/auth/csrf', cookie });
    assert.equal(res.statusCode, 200);
    return { token: res.json().csrfToken, cookie: res.cookie };
  }

  async function post(path, body, cookie) {
    const csrf = await getCsrf(cookie);
    return request(app, {
      method: 'POST',
      path,
      body,
      cookie: csrf.cookie,
      headers: { 'X-CSRF-Token': csrf.token },
    });
  }

  before(async () => {
    ({ createApp } = require('../src/app'));
    ({ getPool, closePool } = require('../src/db/pool'));
    const fs = require('fs');
    const path = require('path');
    for (const file of ['001_auth.sql', '002_fix_session_oids.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8');
      await getPool().query(sql);
    }
    store = new pgSession({
      pool: getPool(),
      tableName: 'session',
      createTableIfMissing: false,
    });
    app = createApp({ sessionStore: store });

    await post('/api/auth/register', {
      name: 'Session User',
      email,
      password,
      passwordConfirm: password,
    });
  });

  after(async () => {
    try {
      await getPool().query(`DELETE FROM users WHERE email_normalized = $1`, [
        email.toLowerCase(),
      ]);
    } catch (_) {}
    try {
      await closePool();
    } catch (_) {}
  });

  it('login persists a row in the session table', async () => {
    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.statusCode, 200);
    assert.ok(login.cookie);

    const { rows } = await getPool().query(`SELECT COUNT(*)::int AS c FROM session`);
    assert.ok(rows[0].c >= 1);

    const me = await request(app, { path: '/api/auth/me', cookie: login.cookie });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.email.toLowerCase(), email.toLowerCase());
  });

  it('session remains valid after recreating the Express app (same PG store)', async () => {
    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookie;

    const app2 = createApp({ sessionStore: store });
    const me = await request(app2, { path: '/api/auth/me', cookie });
    assert.equal(me.statusCode, 200);
    assert.ok(me.json().user);
  });

  it('logout destroys the session so /me fails', async () => {
    const login = await post('/api/auth/login', { email, password });
    const cookie = login.cookie;
    const logout = await post('/api/auth/logout', {}, cookie);
    assert.equal(logout.statusCode, 200);
    const me = await request(app, { path: '/api/auth/me', cookie });
    assert.equal(me.statusCode, 401);
  });

  it('password reset revokes sessions in PostgreSQL', async () => {
    const crypto = require('../src/utils/crypto');
    const raw = crypto.generateToken();
    const hash = crypto.hashToken(raw);
    const { rows: users } = await getPool().query(
      `SELECT id FROM users WHERE email_normalized = $1`,
      [email.toLowerCase()]
    );
    await getPool().query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + interval '1 hour')`,
      [users[0].id, hash]
    );

    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookie;

    const newPass = 'rotated-pass-42';
    const reset = await post('/api/auth/reset-password', {
      token: raw,
      password: newPass,
      passwordConfirm: newPass,
    });
    assert.equal(reset.statusCode, 200);

    const me = await request(app, { path: '/api/auth/me', cookie });
    assert.equal(me.statusCode, 401);

    const login2 = await post('/api/auth/login', { email, password: newPass });
    assert.equal(login2.statusCode, 200);
  });
});
