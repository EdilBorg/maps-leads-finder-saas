const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTestDbSafety } = require('./helpers/testDbGuard');

describe('testDbGuard', () => {
  const original = { ...process.env };

  function resetEnv(overrides = {}) {
    for (const k of Object.keys(process.env)) {
      if (!(k in original)) delete process.env[k];
    }
    Object.assign(process.env, original, overrides);
  }

  it('rejects production', () => {
    resetEnv({ NODE_ENV: 'production', ALLOW_DB_TESTS: '1', PGDATABASE: 'maps_leads_finder_test' });
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('rejects missing ALLOW_DB_TESTS', () => {
    resetEnv({ NODE_ENV: 'test', PGDATABASE: 'maps_leads_finder_test' });
    delete process.env.ALLOW_DB_TESTS;
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('rejects DB name without _test suffix when TEST_DATABASE_NAME unset', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder',
    });
    delete process.env.TEST_DATABASE_NAME;
    delete process.env.PGDATABASE;
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('accepts DB name ending with _test when ALLOW_DB_TESTS=1', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    delete process.env.TEST_DATABASE_NAME;
    const r = evaluateTestDbSafety();
    assert.equal(r.ok, true);
    assert.equal(r.databaseName, 'maps_leads_finder_test');
  });

  it('accepts exact TEST_DATABASE_NAME match', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      TEST_DATABASE_NAME: 'mlf_ci',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/mlf_ci',
    });
    assert.equal(evaluateTestDbSafety().ok, true);
  });
});
