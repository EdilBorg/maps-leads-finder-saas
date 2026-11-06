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
 * - Production: TEST_DATABASE_URL is always rejected.
 * - Production: ALLOW_DB_TESTS=1 is always rejected.
 * - If both DATABASE_URL and TEST_DATABASE_URL are set and differ → ambiguous (error).
 * - Non-production: TEST_DATABASE_URL without ALLOW_DB_TESTS=1 → error.
 * - Non-production: ALLOW_DB_TESTS=1 + TEST_DATABASE_URL → use TEST_DATABASE_URL only.
 * - Else if DATABASE_URL is set → use DATABASE_URL.
 * - Else use discrete PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
 */
function resolveConnection() {
  const isProduction = process.env.NODE_ENV === 'production';
  const testUrl = process.env.TEST_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  const allowTests = process.env.ALLOW_DB_TESTS === '1';

  if (isProduction && testUrl) {
    return {
      ok: false,
      reason:
        'TEST_DATABASE_URL must not be set when NODE_ENV=production. ' +
        'Remove TEST_DATABASE_URL from the production environment.',
    };
  }

  if (isProduction && allowTests) {
    return {
      ok: false,
      reason:
        'ALLOW_DB_TESTS=1 is forbidden when NODE_ENV=production. ' +
        'Integration test mode cannot run in production.',
    };
  }

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
