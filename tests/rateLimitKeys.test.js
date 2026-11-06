const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { loginRateKey, clientIp } = require('../src/middleware/rateLimitKeys');
const auth = fs.readFileSync(path.join(__dirname, '../src/routes/auth.js'), 'utf8');

describe('shared loginRateKey', () => {
  it('formats login:${req.ip}', () => {
    const req = { ip: '127.0.0.1' };
    assert.equal(loginRateKey(req), 'login:127.0.0.1');
    assert.equal(clientIp(req), '127.0.0.1');
  });

  it('uses null when req.ip missing', () => {
    assert.equal(loginRateKey({}), 'login:null');
  });

  it('auth login limiter references loginRateKey (not inline template)', () => {
    assert.match(auth, /keyFn:\s*loginRateKey/);
    assert.doesNotMatch(auth, /keyFn:\s*\(req\)\s*=>\s*`login:\$\{/);
  });
});
