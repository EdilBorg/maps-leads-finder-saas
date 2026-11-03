/**
 * Basic health endpoint test.
 * Runs with: npm test
 * Does not require a live PostgreSQL instance for the process to respond.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Import app (does not start listening when required; we control the server)
const app = require('../src/server');

function request(path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          server.close();
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body,
          });
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

describe('GET /api/health', () => {
  it('returns 200 and valid JSON structure', async () => {
    const res = await request('/api/health');
    assert.equal(res.statusCode, 200);

    const data = JSON.parse(res.body);
    assert.equal(data.status, 'ok');
    assert.equal(data.service, 'maps-leads-finder-saas');
    assert.ok(data.version);
    assert.ok(data.timestamp);
    assert.ok(typeof data.uptimeSeconds === 'number');
    assert.ok(data.database);
    assert.ok(typeof data.database.connected === 'boolean');
  });
});
