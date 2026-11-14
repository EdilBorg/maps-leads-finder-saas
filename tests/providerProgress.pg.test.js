/**
 * Integration tests for updateProviderProgress against real PostgreSQL.
 * Requires: ALLOW_DB_TESTS=1 and a safe *_test database (see testDbGuard).
 * Without that, the suite is skipped — never mocked as if it ran.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');
const { applyMigrationsOnce } = require('./helpers/applyMigrationsOnce');

const RUN = shouldRunDbIntegration();

describe('provider progress persistence (pg)', { skip: !RUN }, () => {
  let pool;
  let userId;
  let searchId;

  before(async () => {
    assertSafeTestDatabase();
    const { getPool } = require('../src/db/pool');
    pool = getPool();
    await applyMigrationsOnce(pool);

    const u = await pool.query(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'x', NOW())
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [`progress-test-${Date.now()}@example.test`]
    );
    if (!u.rows[0]) {
      const any = await pool.query(`SELECT id FROM users LIMIT 1`);
      userId = any.rows[0].id;
    } else {
      userId = u.rows[0].id;
    }
  });

  after(async () => {
    if (!pool || !searchId) return;
    try {
      await pool.query('DELETE FROM searches WHERE id=$1', [searchId]);
    } catch (_) {}
  });

  async function insertRunningSearch(providers) {
    const ins = await pool.query(
      `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at)
       VALUES ($1, 'q', 'loc', '{}'::jsonb, 'running', $2::jsonb, NOW())
       RETURNING id`,
      [userId, JSON.stringify(providers)]
    );
    return ins.rows[0].id;
  }

  it('updates one provider without changing the others', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    searchId = await insertRunningSearch([
      { code: 'apify', status: 'pending', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'foursquare', status: 'pending', count: 0 },
    ]);
    await updateProviderProgress(pool, searchId, userId, {
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
    searchId = await insertRunningSearch([
      { code: 'apify', status: 'pending', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'foursquare', status: 'pending', count: 0 },
    ]);
    await Promise.all([
      updateProviderProgress(pool, searchId, userId, { code: 'apify', status: 'ok', count: 10 }),
      updateProviderProgress(pool, searchId, userId, { code: 'tomtom', status: 'empty', count: 0 }),
      updateProviderProgress(pool, searchId, userId, { code: 'foursquare', status: 'ok', count: 5 }),
    ]);
    const { rows } = await pool.query(
      `SELECT providers_used FROM searches WHERE id=$1`, [searchId]
    );
    const by = Object.fromEntries(rows[0].providers_used.map((p) => [p.code, p]));
    assert.equal(by.apify.status, 'completed');
    assert.equal(by.apify.count, 10);
    assert.equal(by.tomtom.status, 'no_results');
    assert.equal(by.foursquare.status, 'completed');
    assert.equal(by.foursquare.count, 5);
  });

  it('refuses updates when search is cancelled', async () => {
    const { updateProviderProgress } = require('../src/services/searchService');
    searchId = await insertRunningSearch([
      { code: 'apify', status: 'running', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'foursquare', status: 'pending', count: 0 },
    ]);
    await pool.query(
      `UPDATE searches SET status='cancelled', completed_at=NOW() WHERE id=$1`,
      [searchId]
    );
    await updateProviderProgress(pool, searchId, userId, {
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
    searchId = await insertRunningSearch([
      { code: 'apify', status: 'completed', count: 3 },
      { code: 'tomtom', status: 'completed', count: 2 },
      { code: 'foursquare', status: 'no_results', count: 0 },
    ]);
    await pool.query(
      `UPDATE searches SET status='completed', completed_at=NOW() WHERE id=$1`,
      [searchId]
    );
    await updateProviderProgress(pool, searchId, userId, {
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
    searchId = await insertRunningSearch([
      { code: 'apify', status: 'failed', count: 0 },
      { code: 'tomtom', status: 'pending', count: 0 },
      { code: 'foursquare', status: 'pending', count: 0 },
    ]);
    await pool.query(
      `UPDATE searches SET status='failed', completed_at=NOW() WHERE id=$1`,
      [searchId]
    );
    await updateProviderProgress(pool, searchId, userId, {
      code: 'tomtom', status: 'ok', count: 1,
    });
    const { rows } = await pool.query(
      `SELECT providers_used FROM searches WHERE id=$1`, [searchId]
    );
    const tomtom = rows[0].providers_used.find((p) => p.code === 'tomtom');
    assert.equal(tomtom.status, 'pending');
  });
});
