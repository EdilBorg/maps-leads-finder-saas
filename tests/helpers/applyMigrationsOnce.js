/**
 * Test helper: apply migrations via the same runner as scripts/migrate.js.
 */
const { applyMigrations } = require('../../src/db/migrate');

/**
 * @param {import('pg').Pool} pool
 */
async function applyMigrationsOnce(pool) {
  await applyMigrations(pool, { log: () => {} });
}

module.exports = { applyMigrationsOnce };
