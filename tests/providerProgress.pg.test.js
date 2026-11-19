/**
 * Integration tests for updateProviderProgress against real PostgreSQL.
 * Requires: ALLOW_DB_TESTS=1 and a safe *_test database (see testDbGuard).
 * Without that, the suite is skipped — never mocked as if it ran.
 *
 * Cleanup: every search and the suite-owned user are tracked and deleted in after(),
 * including when individual tests fail. Cleanup errors are not swallowed.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');

const RUN = shouldRunDbIntegration();

describe('provider progress persistence (pg)', { skip: !RUN }, () => {
  let pool;
  /** @type {string|null} */
  let ownedUserId = null;
  /** @type {string[]} */
  const createdSearchIds = [];

  before(async () => {
    assertSafeTestDatabase();
    const { applyMigrationsOnce } = require('./helpers/applyMigrationsOnce');
    const { getPool } = require('../src/db/pool');
    pool = getPool();
    await applyMigrationsOnce(pool);

    const email = `progress-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'x', NOW())
       RETURNING id`,
      [email]
    );
    if (!u.rows[0]) {
      throw new Error('providerProgress.pg: failed to insert suite-owned test user');
    }
    ownedUserId = u.rows[0].id;
  });

  after(async () => {
    if (!pool) return;
    const errors = [];

    // Delete searches owned by this suite (FK cascade removes search_results).
    if (createdSearchIds.length > 0) {
      try {
        await pool.query(
          `DELETE FROM searches WHERE id = ANY($1::uuid[])`,
          [createdSearchIds]
        );
      } catch (err) {
        errors.push(err);
      }
    }

    // Also sweep any leftover searches for the suite user, then the user itself.
    if (ownedUserId) {
      try {
        await pool.query(`DELETE FROM searches WHERE user_id = $1`, [ownedUserId]);
      } catch (err) {
        errors.push(err);
      }
      try {
        await pool.query(`DELETE FROM users WHERE id = $1`, [ownedUserId]);
      } catch (err) {
        errors.push(err);
      }
    }

    if (errors.length > 0) {
      const messages = errors.map((e) => (e && e.message) || String(e)).join('; ');
      throw new Error(`providerProgress.pg cleanup failed: ${messages}`);
    }
  });

  async function insertRunningSearch(providers) {
    if (!ownedUserId) throw new Error('suite user not initialized');
    const ins = await pool.query(
      `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at)
       VALUES ($1, 'q', 'loc', '{}'::jsonb, 'running', $2::jsonb, NOW())
       RETURNING id`,
      [ownedUserId, JSON.stringify(providers)]
    );
    const id = ins.rows[0].id;
    createdSearchIds.push(id);
    return id;
  }

  it('updates one provider without changing the others', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const searchId = await insertRunningSearch([
      { code: 'apify', status: 'pending', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'brightdata', status: 'pending', count: 0 },
    ]);
    await updateProviderProgress(pool, searchId, ownedUserId, {
      code: 'apify', status: 'ok', count: 7,
    });
    const { rows } = await pool.query(
      `SELECT providers_used FROM searches WHERE id=$1`, [searchId]
    );
    const providers = rows[0].providers_used;
    const apify = providers.find((p) => p.code === 'apify');
    const tomtom = providers.find((p) => p.code === 'tomtom');
    assert.equal(apify.status, 'completed');
    assert.equal(apify.count, 7);
    assert.equal(tomtom.status, 'pending');
    assert.equal(tomtom.count, 0);
  });

  it('handles concurrent updates without loss', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const searchId = await insertRunningSearch([
      { code: 'apify', status: 'pending', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'brightdata', status: 'pending', count: 0 },
    ]);
    await Promise.all([
      updateProviderProgress(pool, searchId, ownedUserId, { code: 'apify', status: 'ok', count: 10 }),
      updateProviderProgress(pool, searchId, ownedUserId, { code: 'tomtom', status: 'empty', count: 0 }),
      updateProviderProgress(pool, searchId, ownedUserId, { code: 'brightdata', status: 'ok', count: 5 }),
    ]);
    const { rows } = await pool.query(
      `SELECT providers_used FROM searches WHERE id=$1`, [searchId]
    );
    const by = Object.fromEntries(rows[0].providers_used.map((p) => [p.code, p]));
    assert.equal(by.apify.status, 'completed');
    assert.equal(by.apify.count, 10);
    assert.equal(by.tomtom.status, 'no_results');
    assert.equal(by.brightdata.status, 'completed');
    assert.equal(by.brightdata.count, 5);
  });

  it('refuses updates when search is cancelled', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const searchId = await insertRunningSearch([
      { code: 'apify', status: 'running', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'brightdata', status: 'pending', count: 0 },
    ]);
    await pool.query(
      `UPDATE searches SET status='cancelled', completed_at=NOW() WHERE id=$1`,
      [searchId]
    );
    await updateProviderProgress(pool, searchId, ownedUserId, {
      code: 'apify', status: 'ok', count: 99,
    });
    const { rows } = await pool.query(
      `SELECT providers_used FROM searches WHERE id=$1`, [searchId]
    );
    const apify = rows[0].providers_used.find((p) => p.code === 'apify');
    assert.equal(apify.status, 'running');
    assert.equal(apify.count, 0);
  });

  it('refuses updates when search is completed', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const searchId = await insertRunningSearch([
      { code: 'apify', status: 'completed', count: 3 },
      { code: 'tomtom', status: 'completed', count: 2 },
      { code: 'brightdata', status: 'no_results', count: 0 },
    ]);
    await pool.query(
      `UPDATE searches SET status='completed', completed_at=NOW() WHERE id=$1`,
      [searchId]
    );
    await updateProviderProgress(pool, searchId, ownedUserId, {
      code: 'tomtom', status: 'ok', count: 50,
    });
    const { rows } = await pool.query(
      `SELECT providers_used FROM searches WHERE id=$1`, [searchId]
    );
    const tomtom = rows[0].providers_used.find((p) => p.code === 'tomtom');
    assert.equal(tomtom.status, 'completed');
    assert.equal(tomtom.count, 2);
  });

  it('refuses updates when search is failed', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const searchId = await insertRunningSearch([
      { code: 'apify', status: 'failed', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'brightdata', status: 'pending', count: 0 },
    ]);
    await pool.query(
      `UPDATE searches SET status='failed', completed_at=NOW() WHERE id=$1`,
      [searchId]
    );
    await updateProviderProgress(pool, searchId, ownedUserId, {
      code: 'tomtom', status: 'ok', count: 1,
    });
    const { rows } = await pool.query(
      `SELECT providers_used FROM searches WHERE id=$1`, [searchId]
    );
    const tomtom = rows[0].providers_used.find((p) => p.code === 'tomtom');
    assert.equal(tomtom.status, 'pending');
  });
});
