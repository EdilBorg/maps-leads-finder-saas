/**
 * Single source of truth for PostgreSQL connection settings.
 * pool.js, migrate.js and testDbGuard all resolve through this module
 * so a validated test config cannot diverge from the live pool.
 */

function nameFromConnectionString(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const name = decodeURIComponent((u.pathname || '').replace(/^\//, ''));
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the connection the application will actually use.
 *
 * Rules:
 * - If both DATABASE_URL and TEST_DATABASE_URL are set and differ → ambiguous (error).
 * - TEST_DATABASE_URL without ALLOW_DB_TESTS=1 → error (never silent fallback).
 * - If ALLOW_DB_TESTS=1 and TEST_DATABASE_URL is set → use TEST_DATABASE_URL only.
 * - Else if DATABASE_URL is set → use DATABASE_URL.
 * - Else use discrete PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
 */
function resolveConnection() {
  const testUrl = process.env.TEST_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  const allowTests = process.env.ALLOW_DB_TESTS === '1';

  if (testUrl && appUrl && testUrl !== appUrl) {
    return {
      ok: false,
      reason:
        'DATABASE_URL and TEST_DATABASE_URL are both set and differ. ' +
        'Refuse to choose — remove one or make them identical so the pool and guard cannot diverge.',
    };
  }

  if (testUrl && !allowTests) {
    return {
      ok: false,
      reason:
        'TEST_DATABASE_URL is set but ALLOW_DB_TESTS is not "1". ' +
        'Refusing to use a test database URL without explicit authorization. ' +
        'Set ALLOW_DB_TESTS=1 for integration tests, or unset TEST_DATABASE_URL for normal operation.',
    };
  }

  if (allowTests && testUrl) {
    return {
      ok: true,
      source: 'TEST_DATABASE_URL',
      connectionString: testUrl,
      database: nameFromConnectionString(testUrl),
    };
  }

  if (appUrl) {
    return {
      ok: true,
      source: 'DATABASE_URL',
      connectionString: appUrl,
      database: nameFromConnectionString(appUrl),
    };
  }

  const database = process.env.PGDATABASE || null;
  return {
    ok: true,
    source: 'PG*',
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database,
  };
}

function buildPoolConfig() {
  const resolved = resolveConnection();
  if (!resolved.ok) {
    throw new Error(`[db] ${resolved.reason}`);
  }
  if (resolved.connectionString) {
    return { connectionString: resolved.connectionString };
  }
  return {
    host: resolved.host,
    port: resolved.port,
    user: resolved.user,
    password: resolved.password,
    database: resolved.database || 'maps_leads_finder',
  };
}

module.exports = {
  resolveConnection,
  buildPoolConfig,
  nameFromConnectionString,
};
