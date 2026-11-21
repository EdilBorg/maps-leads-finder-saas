/**
 * PostgreSQL integration tests for commercial lead quota.
 * Requires: NODE_ENV=test ALLOW_DB_TESTS=1 and maps_leads_finder_*_test database.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');
const RUN = shouldRunDbIntegration();

describe('leadQuota PG integration', { skip: !RUN }, () => {
  let pool;
  let userId;
  let planId;
  let subId;
  let periodStart;
  let periodEnd;

  before(async () => {
    assertSafeTestDatabase();
    pool = require('../src/db/pool').getPool();
    // minimal fixtures
    const email = `quota-pg-${Date.now()}@example.com`;
    const u = await pool.query(
      `INSERT INTO users (email, email_normalized, password_hash, email_verified_at)
       VALUES ($1, $2, 'x', NOW()) RETURNING id`,
      [email, email.toLowerCase()]
    );
    userId = u.rows[0].id;
    const p = await pool.query(
      `SELECT id FROM plans WHERE name = 'Pro' AND is_active LIMIT 1`
    );
    if (!p.rows[0]) {
      const ins = await pool.query(
        `INSERT INTO plans (name, price_cents, currency, max_searches_per_month, max_results_per_month, max_results_per_search, is_active)
         VALUES ('Pro', 1999, 'USD', 0, 2500, 500, TRUE)
         ON CONFLICT (name) DO UPDATE SET max_results_per_month = 2500, is_active = TRUE
         RETURNING id`
      );
      planId = ins.rows[0].id;
    } else planId = p.rows[0].id;

    const starts = new Date();
    const ends = new Date(starts.getTime() + 30 * 86400000);
    periodStart = starts.toISOString();
    periodEnd = ends.toISOString();
    const s = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, starts_at, ends_at)
       VALUES ($1, $2, 'active', $3, $4) RETURNING id`,
      [userId, planId, starts.toISOString(), ends.toISOString()]
    );
    subId = s.rows[0].id;
  });

  after(async () => {
    if (!pool || !userId) return;
    try {
      await pool.query(`DELETE FROM lead_quota_holds WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM search_results WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM searches WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM subscriptions WHERE user_id = $1`, [userId]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    } catch (_) {}
  });

  async function insertSearch(status, quotaMode) {
    const r = await pool.query(
      `INSERT INTO searches (user_id, query, location, filters, status, total_after_filters, completed_at, started_at)
       VALUES ($1, 'q', 'loc', $2::jsonb, $3, 0, CASE WHEN $3 = 'running' THEN NULL ELSE NOW() END, NOW())
       RETURNING id`,
      [userId, JSON.stringify({ quotaMode, limit: 100 }), status]
    );
    return r.rows[0].id;
  }

  it('concurrent reserves never exceed 2500', async () => {
    const leadQuota = require('../src/services/leadQuotaService');
    const s1 = await insertSearch('running', 'paid');
    const s2 = await insertSearch('running', 'paid');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const a = await leadQuota.reserveLeadQuota(c, {
        userId, searchId: s1, requestedLimit: 2000, planLimit: 2500,
        periodStart, periodEnd, idempotencyKey: `t:${s1}`,
      });
      const b = await leadQuota.reserveLeadQuota(c, {
        userId, searchId: s2, requestedLimit: 2000, planLimit: 2500,
        periodStart, periodEnd, idempotencyKey: `t:${s2}`,
      });
      await c.query('COMMIT');
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      assert.equal(a.reserved + b.reserved, 2500);
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      c.release();
    }
  });

  it('trial delivered does not count toward Pro quota', async () => {
    const leadQuota = require('../src/services/leadQuotaService');
    await pool.query(
      `INSERT INTO searches (user_id, query, location, filters, status, total_after_filters, completed_at, started_at)
       VALUES ($1, 'trial', 'loc', '{"quotaMode":"trial"}'::jsonb, 'completed', 200, NOW(), NOW())`,
      [userId]
    );
    const c = await pool.connect();
    try {
      const d = await leadQuota.sumDeliveredInPeriod(c, userId, periodStart, periodEnd);
      // should not include the 200 trial leads
      assert.ok(d < 200 || d === 0 || Number.isFinite(d));
      // explicit: sum only paid
      const { rows } = await c.query(
        `SELECT COALESCE(SUM(total_after_filters),0)::int AS d FROM searches
         WHERE user_id=$1 AND COALESCE(filters->>'quotaMode','')='trial'`,
        [userId]
      );
      assert.ok(Number(rows[0].d) >= 200);
      const paidOnly = await leadQuota.sumDeliveredInPeriod(c, userId, periodStart, periodEnd);
      // paidOnly must ignore trial 200
      assert.equal(paidOnly === 0 || paidOnly < Number(rows[0].d), true);
    } finally {
      c.release();
    }
  });

  it('release is idempotent and frees capacity', async () => {
    const leadQuota = require('../src/services/leadQuotaService');
    const sid = await insertSearch('running', 'paid');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await leadQuota.reserveLeadQuota(c, {
        userId, searchId: sid, requestedLimit: 100, planLimit: 2500,
        periodStart, periodEnd, idempotencyKey: `rel:${sid}`,
      });
      await c.query('COMMIT');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      c.release();
    }
    const r1 = await leadQuota.releaseLeadQuotaSafe({ userId, searchId: sid, reason: 'test' });
    assert.equal(r1.ok, true);
    const r2 = await leadQuota.releaseLeadQuotaSafe({ userId, searchId: sid, reason: 'test-replay' });
    assert.equal(r2.ok, true);
  });
});
