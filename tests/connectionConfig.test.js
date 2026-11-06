const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('resolveConnection production safety', () => {
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
  }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
    delete require.cache[require.resolve('../src/db/connectionConfig')];
  });

  it('Production + TEST_DATABASE_URL → rejected', () => {
    resetEnv({
      NODE_ENV: 'production',
      TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder',
    });
    const { resolveConnection } = require('../src/db/connectionConfig');
    const r = resolveConnection();
    assert.equal(r.ok, false);
    assert.match(r.reason, /TEST_DATABASE_URL|production/i);
  });

  it('Production + ALLOW_DB_TESTS=1 → rejected', () => {
    resetEnv({
      NODE_ENV: 'production',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder',
    });
    const { resolveConnection } = require('../src/db/connectionConfig');
    const r = resolveConnection();
    assert.equal(r.ok, false);
    assert.match(r.reason, /ALLOW_DB_TESTS|production/i);
  });

  it('Production + DATABASE_URL only → allowed', () => {
    resetEnv({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder',
    });
    const { resolveConnection, buildPoolConfig } = require('../src/db/connectionConfig');
    const r = resolveConnection();
    assert.equal(r.ok, true);
    assert.equal(r.source, 'DATABASE_URL');
    assert.equal(r.database, 'maps_leads_finder');
    assert.equal(buildPoolConfig().connectionString, r.connectionString);
  });

  it('Development + TEST_DATABASE_URL without opt-in → rejected', () => {
    resetEnv({
      NODE_ENV: 'development',
      TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { resolveConnection } = require('../src/db/connectionConfig');
    assert.equal(resolveConnection().ok, false);
  });

  it('Development + TEST_DATABASE_URL + ALLOW_DB_TESTS=1 → allowed', () => {
    resetEnv({
      NODE_ENV: 'development',
      ALLOW_DB_TESTS: '1',
      TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
    });
    const { resolveConnection } = require('../src/db/connectionConfig');
    const r = resolveConnection();
    assert.equal(r.ok, true);
    assert.equal(r.source, 'TEST_DATABASE_URL');
    assert.equal(r.database, 'maps_leads_finder_test');
  });

  it('Development + DATABASE_URL without TEST_DATABASE_URL → allowed', () => {
    resetEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder',
    });
    const { resolveConnection } = require('../src/db/connectionConfig');
    const r = resolveConnection();
    assert.equal(r.ok, true);
    assert.equal(r.source, 'DATABASE_URL');
  });

  it('Divergent URLs → rejected', () => {
    resetEnv({
      NODE_ENV: 'test',
      ALLOW_DB_TESTS: '1',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/maps_leads_finder_test',
      TEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/other_test',
    });
    const { resolveConnection } = require('../src/db/connectionConfig');
    assert.equal(resolveConnection().ok, false);
  });
});
