const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('testDbGuard + connectionConfig alignment', () => {
  const original = { ...process.env };

  function resetEnv(overrides = {}) {
    for (const key of [
      'NODE_ENV',
      'ALLOW_DB_TESTS',
      'DATABASE_URL',
      'TEST_DATABASE_URL',
      'TEST_DATABASE_NAME',
      'PGDATABASE',
      'PGHOST',
      'PGUSER',
      'PGPASSWORD',
      'PGPORT',
    ]) {
      delete process.env[key];
    }
    Object.assign(process.env, overrides);
    delete require.cache[require.resolve('../src/db/connectionConfig')];
    delete require.cache[require.resolve('./helpers/testDbGuard')];
  }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
    delete require.cache[require.resolve('../src/db/connectionConfig')];
    delete require.cache[require.resolve('./helpers/testDbGuard')];
  });

  it('accepts a valid *_test database with ALLOW_DB_TESTS=1', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { evaluateTestDbSafety, resolveConnection } = require('./helpers/testDbGuard');
    const safety = evaluateTestDbSafety();
    const conn = resolveConnection();
    assert.equal(safety.ok, true);
    assert.equal(safety.databaseName, 'maps_leads_finder_test');
    assert.equal(conn.ok, true);
    assert.equal(conn.database, safety.databaseName);
  });

  it('rejects database without test identification', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('rejects NODE_ENV=production always', () => {
    resetEnv({
      NODE_ENV: 'production',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('rejects missing ALLOW_DB_TESTS', () => {
    resetEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('rejects divergent DATABASE_URL and TEST_DATABASE_URL', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
      TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/other_test',
    });
    const { evaluateTestDbSafety, resolveConnection } = require('./helpers/testDbGuard');
    assert.equal(resolveConnection().ok, false);
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('resolved connection matches buildPoolConfig when using TEST_DATABASE_URL', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { evaluateTestDbSafety, resolveConnection } = require('./helpers/testDbGuard');
    const { buildPoolConfig } = require('../src/db/connectionConfig');
    const safety = evaluateTestDbSafety();
    const conn = resolveConnection();
    const poolCfg = buildPoolConfig();
    assert.equal(safety.ok, true);
    assert.equal(conn.source, 'TEST_DATABASE_URL');
    assert.equal(poolCfg.connectionString, conn.connectionString);
    assert.equal(safety.databaseName, 'maps_leads_finder_test');
  });

  it('accepts TEST_DATABASE_NAME exact match for non-_test suffix', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      TEST_DATABASE_NAME: 'mlf_ci',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/mlf_ci',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(evaluateTestDbSafety().ok, true);
  });
});
