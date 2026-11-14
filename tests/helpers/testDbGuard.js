/**
 * Guard against running integration tests against production databases.
 *
 * Validates the SAME connection resolveConnection() / buildPoolConfig() use,
 * so the pool cannot silently target a different database than the one checked.
 *
 * Safety rules (all must pass):
 * - NODE_ENV must not be production
 * - ALLOW_DB_TESTS must be exactly "1"
 * - Resolved database name must end with "_test"
 * - If TEST_DATABASE_NAME is set, it must equal the resolved name (confirmation only;
 *   it cannot authorize a non-_test database)
 */

const { resolveConnection, nameFromConnectionString } = require('../../src/db/connectionConfig');

function evaluateTestDbSafety() {
  if (process.env.NODE_ENV === 'production') {
    return { ok: false, reason: 'NODE_ENV=production — integration DB tests are forbidden.' };
  }
  if (process.env.ALLOW_DB_TESTS !== '1') {
    return {
      ok: false,
      reason:
        'ALLOW_DB_TESTS is not set to 1. Integration tests that touch PostgreSQL require explicit opt-in.',
    };
  }

  const resolved = resolveConnection();
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  const dbName = resolved.database;
  if (!dbName) {
    return {
      ok: false,
      reason:
        'No database name in the resolved connection (set DATABASE_URL or TEST_DATABASE_URL with a path, or PGDATABASE).',
    };
  }

  // Hard rule: the resolved database must always look like a test database.
  // TEST_DATABASE_NAME is only a confirmation of the expected name — never a bypass.
  if (!dbName.endsWith('_test')) {
    return {
      ok: false,
      reason:
        `Resolved database "${dbName}" (source=${resolved.source}) must end with "_test". ` +
        'TEST_DATABASE_NAME cannot authorize a non-test database.',
    };
  }

  const expected = process.env.TEST_DATABASE_NAME;
  if (expected && dbName !== expected) {
    return {
      ok: false,
      reason: `Resolved database "${dbName}" (source=${resolved.source}) does not match TEST_DATABASE_NAME="${expected}".`,
    };
  }

  // If TEST_DATABASE_NAME is set, it must itself end with _test (defense in depth).
  if (expected && !expected.endsWith('_test')) {
    return {
      ok: false,
      reason:
        `TEST_DATABASE_NAME="${expected}" must end with "_test". ` +
        'Refusing to treat a non-test name as an expected integration database.',
    };
  }

  return { ok: true, databaseName: dbName, source: resolved.source };
}

function assertSafeTestDatabase() {
  const result = evaluateTestDbSafety();
  if (!result.ok) {
    const err = new Error(`[testDbGuard] ${result.reason}`);
    err.code = 'UNSAFE_TEST_DB';
    throw err;
  }
  return result.databaseName;
}

function shouldRunDbIntegration() {
  return evaluateTestDbSafety().ok;
}

module.exports = {
  evaluateTestDbSafety,
  assertSafeTestDatabase,
  shouldRunDbIntegration,
  resolveConnection,
  nameFromConnectionString,
};
