/**
 * Integration: connect-pg-simple session persistence against a dedicated test DB.
 *
 * Requires:
 *   ALLOW_DB_TESTS=1
 *   DATABASE_URL pointing at a DB whose name ends with _test
 *   NODE_ENV !== production
 *
 * Process-restart proof: after login, a child Node process
 * (tests/helpers/session_child.js) boots a new app and must accept the same cookie.
 */
require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('path');
const { spawnSync } = require('node:child_process');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');

function request(app, { method = 'GET', path: reqPath, body, cookie, headers = {} } = {}) {
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
        { hostname: '127.0.0.1', port, path: reqPath, method, headers: reqHeaders },
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

describe('PostgreSQL session store (connect-pg-simple)', { skip: !shouldRunDbIntegration() }, () => {
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

  async function post(p, body, cookie) {
    const csrf = await getCsrf(cookie);
    return request(app, {
      method: 'POST',
      path: p,
      body,
      cookie: csrf.cookie,
      headers: { 'X-CSRF-Token': csrf.token },
    });
  }

  before(async () => {
    assertSafeTestDatabase();
    ({ createApp } = require('../src/app'));
    ({ getPool, closePool } = require('../src/db/pool'));
    const fs = require('fs');
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
  });

  it('new Node process recovers the session from PostgreSQL via cookie', async () => {
    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookie;

    const child = path.join(__dirname, 'helpers', 'session_child.js');
    const result = spawnSync(process.execPath, [child], {
      env: {
        ...process.env,
        SESSION_COOKIE: cookie,
        ALLOW_DB_TESTS: '1',
      },
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.equal(
      result.status,
      0,
      `child failed: status=${result.status} stderr=${result.stderr} stdout=${result.stdout}`
    );
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
