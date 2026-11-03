/**
 * Guard against running integration tests against production databases.
 *
 * Validates the SAME connection resolveConnection() / buildPoolConfig() use,
 * so the pool cannot silently target a different database than the one checked.
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

  const expected = process.env.TEST_DATABASE_NAME;
  if (expected) {
    if (dbName !== expected) {
      return {
        ok: false,
        reason: `Resolved database "${dbName}" (source=${resolved.source}) does not match TEST_DATABASE_NAME="${expected}".`,
      };
    }
  } else if (!dbName.endsWith('_test')) {
    return {
      ok: false,
      reason: `Resolved database "${dbName}" (source=${resolved.source}) must end with "_test" (or set TEST_DATABASE_NAME).`,
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
