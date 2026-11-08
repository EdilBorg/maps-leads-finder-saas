/**
 * Integration: connect-pg-simple session persistence against a dedicated test DB.
 *
 * Requires:
 *   ALLOW_DB_TESTS=1
 *   DATABASE_URL (or TEST_DATABASE_URL) pointing at a DB whose name ends with _test
 *   NODE_ENV !== production
 *
 * Process-restart proof: after login in this process, a child Node process
 * (tests/helpers/session_child.js) boots a new app and must accept the same cookie.
 */
require('dotenv').config();
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('path');
const { spawnSync } = require('node:child_process');
const pgSession = require('connect-pg-simple')(require('express-session'));
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');
const { clearAuthTestState } = require('./helpers/clearAuthTestState');

const RUN = shouldRunDbIntegration();

function request(app, { method = 'GET', path: p, body, cookie, headers = {} }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body != null ? JSON.stringify(body) : null;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: p,
          method,
          headers: {
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
              : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const raw = Buffer.concat(chunks).toString('utf8');
            let json;
            try {
              json = raw ? JSON.parse(raw) : null;
            } catch (_) {
              json = null;
            }
            const setCookie = res.headers['set-cookie'];
            const cookieHeader = setCookie
              ? setCookie.map((c) => c.split(';')[0]).join('; ')
              : cookie || '';
            resolve({ statusCode: res.statusCode, json, cookie: cookieHeader, raw });
          });
        }
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

describe('session PostgreSQL persistence', { skip: !RUN }, () => {
  let createApp;
  let getPool;
  let closePool;
  let app;
  let store;
  const email = `session_${Date.now()}@test.local`;
  const password = 'Session-pass-99';

  async function getCsrf(cookie) {
    const res = await request(app, { path: '/api/auth/csrf', cookie });
    assert.equal(
      res.statusCode,
      200,
      `CSRF endpoint status ${res.statusCode} body=${res.raw}`
    );
    assert.ok(res.json && typeof res.json === 'object', `CSRF response JSON missing or invalid: ${res.raw}`);
    const token = res.json.csrfToken;
    assert.ok(
      token && typeof token === 'string' && token.length > 10,
      `CSRF token missing or too short: ${JSON.stringify(res.json)}`
    );
    return { token, cookie: res.cookie };
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

    await clearAuthTestState({ emails: [email] });

    const reg = await post('/api/auth/register', {
      name: 'Session User',
      email,
      password,
      passwordConfirm: password,
    });
    if (reg.statusCode !== 200 && reg.statusCode !== 201) {
      throw new Error(
        `session.pg setup register failed: status=${reg.statusCode} body=${JSON.stringify(reg.json)}`
      );
    }
  });

  after(async () => {
    try {
      await clearAuthTestState({ emails: [email] });
    } catch (_) {}
    try {
      await getPool().query(`DELETE FROM users WHERE email_normalized = $1`, [
        email.toLowerCase(),
      ]);
    } catch (_) {}
    try {
      await closePool();
    } catch (_) {}
  });

  beforeEach(async () => {
    await clearAuthTestState({ emails: [email] });
  });

  it('login persists a row in the session table', async () => {
    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.statusCode, 200, `login status ${login.statusCode} body=${JSON.stringify(login.json)}`);
    assert.ok(login.cookie);

    const { rows } = await getPool().query(`SELECT COUNT(*)::int AS c FROM session`);
    assert.ok(rows[0].c >= 1);

    const me = await request(app, { path: '/api/auth/me', cookie: login.cookie });
    assert.equal(me.statusCode, 200);
  });

  it('new Node process recovers the session from PostgreSQL via cookie', async () => {
    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.statusCode, 200, `login status ${login.statusCode} body=${JSON.stringify(login.json)}`);
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
    assert.equal(login.statusCode, 200);
    const cookie = login.cookie;
    const logout = await post('/api/auth/logout', {}, cookie);
    assert.equal(logout.statusCode, 200);
    const me = await request(app, { path: '/api/auth/me', cookie });
    assert.equal(me.statusCode, 401);
  });

  it('password reset revokes sessions in PostgreSQL', async () => {
    const login = await post('/api/auth/login', { email, password });
    assert.equal(login.statusCode, 200, `login status ${login.statusCode}`);
    const cookie = login.cookie;

    const { rows: users } = await getPool().query(
      `SELECT id FROM users WHERE email_normalized = $1`,
      [email.toLowerCase()]
    );
    assert.ok(users[0] && users[0].id, 'registered user must exist');

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await getPool().query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + interval '1 hour')`,
      [users[0].id, tokenHash]
    );

    const reset = await post('/api/auth/reset-password', {
      token,
      password: 'Session-pass-00',
      passwordConfirm: 'Session-pass-00',
    });
    assert.equal(reset.statusCode, 200, `reset status ${reset.statusCode} body=${JSON.stringify(reset.json)}`);

    const me = await request(app, { path: '/api/auth/me', cookie });
    assert.equal(me.statusCode, 401);
  });
});
