const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeEmail,
  isValidEmail,
  isValidPassword,
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
} = require('../src/utils/crypto');

describe('crypto utils', () => {
  it('normalizes email', () => {
    assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
  });

  it('validates email', () => {
    assert.equal(isValidEmail('a@b.co'), true);
    assert.equal(isValidEmail('bad'), false);
    assert.equal(isValidEmail(''), false);
  });

  it('validates password length', () => {
    assert.equal(isValidPassword('short'), false);
    assert.equal(isValidPassword('longenough'), true);
  });

  it('hashes and verifies with Argon2id', async () => {
    const hash = await hashPassword('correct-horse-battery');
    assert.ok(hash.startsWith('$argon2'));
    assert.equal(await verifyPassword(hash, 'correct-horse-battery'), true);
    assert.equal(await verifyPassword(hash, 'wrong'), false);
  });

  it('token hash is deterministic and not reversible', () => {
    const t = generateToken();
    assert.ok(t.length > 20);
    const h1 = hashToken(t);
    const h2 = hashToken(t);
    assert.equal(h1, h2);
    assert.notEqual(h1, t);
  });
});
