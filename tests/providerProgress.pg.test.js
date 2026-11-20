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
      `INSERT INTO users (email, email_normalized, password_hash, name, email_verified_at)
       VALUES ($1, $2, 'x', 'Progress Test', NOW())
       RETURNING id`,
      [email, email.toLowerCase()]
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
      `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
       VALUES ($1, 'progress-q', 'loc', '{}'::jsonb, 'running', $2::jsonb, NOW(), NOW() + interval '30 days')
       RETURNING id`,
      [ownedUserId, JSON.stringify(providers)]
    );
    const id = ins.rows[0].id;
    createdSearchIds.push(id);
    return id;
  }

  it('updates one provider status without touching others', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const searchId = await insertRunningSearch([
      { code: 'apify', status: 'pending', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'brightdata', status: 'pending', count: 0 },
    ]);

    await updateProviderProgress(pool, searchId, ownedUserId, {
      code: 'apify',
      status: 'ok',
      count: 12,
    });

    const { rows } = await pool.query(
      `SELECT providers_used FROM searches WHERE id = $1 AND user_id = $2`,
      [searchId, ownedUserId]
    );
    const providers = rows[0].providers_used;
    const apify = providers.find((p) => p.code === 'apify');
    const tomtom = providers.find((p) => p.code === 'tomtom');
    assert.equal(apify.status, 'ok');
    assert.equal(apify.count, 12);
    assert.equal(tomtom.status, 'pending');
  });

  it('maps cancelled engine status for UI', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const searchId = await insertRunningSearch([
      { code: 'apify', status: 'pending', count: 0 },
    ]);
    await updateProviderProgress(pool, searchId, ownedUserId, {
      code: 'apify',
      status: 'cancelled',
      count: 0,
    });
    const { rows } = await pool.query(`SELECT providers_used FROM searches WHERE id = $1`, [searchId]);
    const apify = rows[0].providers_used.find((p) => p.code === 'apify');
    assert.ok(apify);
    assert.equal(apify.status, 'cancelled');
  });

  it('is a no-op for unknown provider code', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const initial = [
      { code: 'apify', status: 'pending', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
    ];
    const searchId = await insertRunningSearch(initial);
    await updateProviderProgress(pool, searchId, ownedUserId, {
      code: 'unknown_provider',
      status: 'ok',
      count: 99,
    });
    const { rows } = await pool.query(`SELECT providers_used FROM searches WHERE id = $1`, [searchId]);
    assert.deepEqual(rows[0].providers_used, initial);
  });

  it('does not update a search belonging to another user', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const searchId = await insertRunningSearch([
      { code: 'apify', status: 'pending', count: 0 },
    ]);
    const fakeOtherUser = '00000000-0000-4000-8000-000000000099';
    await updateProviderProgress(pool, searchId, fakeOtherUser, {
      code: 'apify',
      status: 'ok',
      count: 5,
    });
    const { rows } = await pool.query(`SELECT providers_used FROM searches WHERE id = $1`, [searchId]);
    assert.equal(rows[0].providers_used.find((p) => p.code === 'apify').status, 'pending');
  });

  it('preserves existing fields when partial progress is applied', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    const searchId = await insertRunningSearch([
      { code: 'apify', status: 'pending', count: 0, errorCode: null },
      { code: 'brightdata', status: 'pending', count: 0 },
    ]);
    await updateProviderProgress(pool, searchId, ownedUserId, {
      code: 'apify',
      status: 'error',
      count: 0,
      errorCode: 'HTTP_ERROR',
    });
    const { rows } = await pool.query(`SELECT providers_used FROM searches WHERE id = $1`, [searchId]);
    const apify = rows[0].providers_used.find((p) => p.code === 'apify');
    assert.equal(apify.status, 'error');
    assert.equal(apify.errorCode, 'HTTP_ERROR');
    const bd = rows[0].providers_used.find((p) => p.code === 'brightdata');
    assert.equal(bd.status, 'pending');
  });
});
