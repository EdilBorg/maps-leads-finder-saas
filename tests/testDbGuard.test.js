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

  it('rejects when ALLOW_DB_TESTS is absent', () => {
    resetEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('rejects ALLOW_DB_TESTS=1 with NODE_ENV=production', () => {
    resetEnv({
      NODE_ENV: 'production',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('accepts *_test database without TEST_DATABASE_NAME', () => {
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
    assert.equal(conn.database, safety.databaseName);
  });

  it('accepts *_test database with matching TEST_DATABASE_NAME', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      TEST_DATABASE_NAME: 'maps_leads_finder_test',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(evaluateTestDbSafety().ok, true);
  });

  it('rejects when TEST_DATABASE_NAME differs from resolved database', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      TEST_DATABASE_NAME: 'other_test',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('rejects TEST_DATABASE_NAME equal to a non-_test database', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      TEST_DATABASE_NAME: 'maps_leads_finder',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    const result = evaluateTestDbSafety();
    assert.equal(result.ok, false);
    assert.match(result.reason, /_test/);
  });

  it('rejects database without _test suffix and without expected name', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder',
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('rejects missing connection configuration (no database name)', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      // no DATABASE_URL / TEST_DATABASE_URL / PGDATABASE
    });
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    const result = evaluateTestDbSafety();
    assert.equal(result.ok, false);
    assert.match(result.reason, /database name|No database/i);
  });

  it('rejects TEST_DATABASE_URL without ALLOW_DB_TESTS=1', () => {
    resetEnv({
      NODE_ENV: 'test',
      TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { resolveConnection } = require('../src/db/connectionConfig');
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    const conn = resolveConnection();
    assert.equal(conn.ok, false);
    assert.match(conn.reason, /ALLOW_DB_TESTS/);
    assert.equal(evaluateTestDbSafety().ok, false);
  });

  it('accepts TEST_DATABASE_URL with ALLOW_DB_TESTS=1 and valid test DB', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { evaluateTestDbSafety, resolveConnection } = require('./helpers/testDbGuard');
    const { buildPoolConfig } = require('../src/db/connectionConfig');
    assert.equal(evaluateTestDbSafety().ok, true);
    const conn = resolveConnection();
    assert.equal(conn.source, 'TEST_DATABASE_URL');
    assert.equal(buildPoolConfig().connectionString, conn.connectionString);
  });

  it('preserves normal DATABASE_URL without TEST_DATABASE_URL', () => {
    resetEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder',
    });
    const { resolveConnection, buildPoolConfig } = require('../src/db/connectionConfig');
    const conn = resolveConnection();
    assert.equal(conn.ok, true);
    assert.equal(conn.source, 'DATABASE_URL');
    assert.equal(conn.database, 'maps_leads_finder');
    assert.equal(buildPoolConfig().connectionString, conn.connectionString);
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

  it('Production + TEST_DATABASE_URL is rejected by resolveConnection', () => {
    resetEnv({
      NODE_ENV: 'production',
      ALLOW_DB_TESTS: '1',
      TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { resolveConnection } = require('../src/db/connectionConfig');
    const { evaluateTestDbSafety } = require('./helpers/testDbGuard');
    assert.equal(resolveConnection().ok, false);
    assert.equal(evaluateTestDbSafety().ok, false);
  });
});
