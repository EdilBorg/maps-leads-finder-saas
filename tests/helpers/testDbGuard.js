/**
 * Guard against running integration tests against production databases.
 *
 * Safe mode requires ALL of:
 * - NODE_ENV !== 'production'
 * - ALLOW_DB_TESTS=1 (explicit opt-in)
 * - DATABASE_URL (or PG*) pointing at a database whose name ends with `_test`
 *   OR equals the value of TEST_DATABASE_NAME
 *
 * Presence of DATABASE_URL alone is NOT enough.
 */

function databaseNameFromEnv() {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (url) {
    try {
      const u = new URL(url);
      const name = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (name) return name;
    } catch (_) {}
  }
  return process.env.PGDATABASE || null;
}

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
  const dbName = databaseNameFromEnv();
  if (!dbName) {
    return {
      ok: false,
      reason: 'No database name found (set TEST_DATABASE_URL or DATABASE_URL / PGDATABASE).',
    };
  }
  const expected = process.env.TEST_DATABASE_NAME;
  if (expected) {
    if (dbName !== expected) {
      return {
        ok: false,
        reason: `Database name "${dbName}" does not match TEST_DATABASE_NAME="${expected}".`,
      };
    }
  } else if (!dbName.endsWith('_test')) {
    return {
      ok: false,
      reason: `Database name "${dbName}" must end with "_test" (or set TEST_DATABASE_NAME to the exact name).`,
    };
  }
  return { ok: true, databaseName: dbName };
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
  databaseNameFromEnv,
};
