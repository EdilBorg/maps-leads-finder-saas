/**
 * Health endpoint tests.
 * Independent of a real PostgreSQL instance.
 * Uses setCheckConnection() to simulate available / unavailable DB.
 * Each test uses an ephemeral server that is closed after the request.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createApp } = require('../src/app');
const { setCheckConnection } = require('../src/db/pool');

function request(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          server.close(() => {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body,
            });
          });
        });
      });
      req.on('error', (err) => {
        server.close(() => reject(err));
      });
    });
    server.on('error', reject);
  });
}

function assertNoLeak(data) {
  const raw = JSON.stringify(data);
  assert.equal(data.database.error, undefined);
  assert.ok(!/password/i.test(raw));
  assert.ok(!/postgresql:\/\//i.test(raw));
  assert.ok(!/ECONNREFUSED/i.test(raw));
  assert.ok(!data.database.message);
  assert.ok(!data.stack);
}

describe('GET /api/health', () => {
  afterEach(() => {
    // Always restore default checker
    setCheckConnection(null);
  });

  it('returns 200 with connected: true when database is available', async () => {
    setCheckConnection(async () => ({ ok: true, latencyMs: 3 }));

    const app = createApp();
    const res = await request(app, '/api/health');

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);

    assert.equal(data.status, 'ok');
    assert.equal(data.service, 'maps-leads-finder-saas');
    assert.ok(data.version);
    assert.ok(data.timestamp);
    assert.ok(typeof data.uptimeSeconds === 'number');
    assert.equal(data.database.connected, true);
    assert.equal(data.database.latencyMs, 3);
    assertNoLeak(data);
  });

  it('returns 200 with connected: false when database is unavailable', async () => {
    setCheckConnection(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432 password=secret');
    });

    const app = createApp();
    const res = await request(app, '/api/health');

    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);

    assert.equal(data.status, 'ok');
    assert.equal(data.database.connected, false);
    assert.equal(data.database.latencyMs, undefined);
    assertNoLeak(data);
    // Must not echo the injected internal message
    assert.ok(!JSON.stringify(data).includes('ECONNREFUSED'));
    assert.ok(!JSON.stringify(data).includes('password=secret'));
  });

  it('never exposes internal error details in the JSON body', async () => {
    setCheckConnection(async () => {
      const err = new Error('FATAL: password authentication failed for user "postgres"');
      err.code = '28P01';
      throw err;
    });

    const app = createApp();
    const res = await request(app, '/api/health');
    const data = JSON.parse(res.body);

    assert.equal(data.database.connected, false);
    assertNoLeak(data);
    const raw = res.body;
    assert.ok(!raw.includes('password authentication'));
    assert.ok(!raw.includes('28P01'));
    assert.ok(!raw.includes('FATAL'));
  });
});
