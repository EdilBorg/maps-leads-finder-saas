/**
 * PostgreSQL integration — commercial lead quota.
 * Only runs with NODE_ENV!=production, ALLOW_DB_TESTS=1, and *_test database.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');

const RUN = shouldRunDbIntegration();

describe('leadQuota PG integration', { skip: !RUN }, () => {
  let pool;
  let leadQuota;
  let userId;
  let planId;
  let periodStart;
  let periodEnd;
  const createdSearchIds = [];

  before(async () => {
    assertSafeTestDatabase();
    pool = require('../src/db/pool').getPool();
    leadQuota = require('../src/services/leadQuotaService');
    const email = `lq-pg-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const u = await pool.query(
      `INSERT INTO users (email, email_normalized, password_hash, email_verified_at)
       VALUES ($1, $2, 'x', NOW()) RETURNING id`,
      [email, email.toLowerCase()]
    );
    userId = u.rows[0].id;
    let p = await pool.query(`SELECT id FROM plans WHERE name = 'Pro' LIMIT 1`);
    if (!p.rows[0]) {
      p = await pool.query(
        `INSERT INTO plans (name, price_cents, currency, max_searches_per_month, max_results_per_month, max_results_per_search, is_active)
         VALUES ('Pro', 1999, 'USD', 0, 2500, 500, TRUE)
         ON CONFLICT (name) DO UPDATE SET max_results_per_month = 2500 RETURNING id`
      );
    }
    planId = p.rows[0].id;
    const starts = new Date();
    const ends = new Date(starts.getTime() + 30 * 86400000);
    periodStart = starts.toISOString();
    periodEnd = ends.toISOString();
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, starts_at, ends_at)
       VALUES ($1, $2, 'active', $3, $4)`,
      [userId, planId, periodStart, periodEnd]
    );
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

  async function mkSearch(status, quotaMode, delivered) {
    const r = await pool.query(
      `INSERT INTO searches (
         user_id, query, location, filters, status, total_after_filters, completed_at, started_at
       ) VALUES (
         $1, 'q', 'loc', $2::jsonb, $3, $4,
         CASE WHEN $3 = 'running' THEN NULL ELSE NOW() END, NOW()
       ) RETURNING id`,
      [userId, JSON.stringify({ quotaMode, limit: 100 }), status, delivered || 0]
    );
    createdSearchIds.push(r.rows[0].id);
    return r.rows[0].id;
  }

  it('two concurrent reserves never exceed 2500', async () => {
    const s1 = await mkSearch('running', 'paid', 0);
    const s2 = await mkSearch('running', 'paid', 0);

    async function reserve(searchId, want, key) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
        const r = await leadQuota.reserveLeadQuota(c, {
          userId, searchId, requestedLimit: want, planLimit: 2500,
          periodStart, periodEnd, idempotencyKey: key,
        });
        await c.query('COMMIT');
        return r;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        c.release();
      }
    }

    const [a, b] = await Promise.all([
      reserve(s1, 2000, `conc-a-${s1}`),
      reserve(s2, 2000, `conc-b-${s2}`),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.reserved + b.reserved, 2500);
    assert.ok(a.reserved === 2000 || b.reserved === 2000);
    assert.ok(a.reserved === 500 || b.reserved === 500);
  });

  it('sumDeliveredInPeriod counts only paid completed/partial in period', async () => {
    await mkSearch('completed', 'paid', 100);
    await mkSearch('partial', 'paid', 40);
    await mkSearch('completed', 'trial', 200);
    await mkSearch('completed', '', 50); // no quotaMode
    await mkSearch('failed', 'paid', 80);
    await mkSearch('cancelled', 'paid', 70);
    const c = await pool.connect();
    try {
      const d = await leadQuota.sumDeliveredInPeriod(c, userId, periodStart, periodEnd);
      assert.equal(d, 140, `expected 100+40 paid only, got ${d}`);
    } finally {
      c.release();
    }
  });

  it('release after cancel and idempotent replay', async () => {
    const sid = await mkSearch('running', 'paid', 0);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      await leadQuota.reserveLeadQuota(c, {
        userId, searchId: sid, requestedLimit: 100, planLimit: 2500,
        periodStart, periodEnd, idempotencyKey: `rel-${sid}`,
      });
      await c.query(`UPDATE searches SET status='cancelled', completed_at=NOW() WHERE id=$1`, [sid]);
      await leadQuota.releaseLeadQuota(c, { userId, searchId: sid });
      await c.query('COMMIT');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      c.release();
    }
    const { rows } = await pool.query(
      `SELECT status FROM lead_quota_holds WHERE search_id = $1`, [sid]
    );
    assert.equal(rows[0].status, 'released');
    const r2 = await leadQuota.releaseLeadQuotaSafe({ userId, searchId: sid, reason: 'replay' });
    assert.equal(r2.ok, true);
  });

  it('orphan recovery releases terminal holds but not running', async () => {
    const dead = await mkSearch('failed', 'paid', 0);
    const live = await mkSearch('running', 'paid', 0);
    for (const [sid, key] of [[dead, 'orph-dead'], [live, 'orph-live']]) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
        await leadQuota.reserveLeadQuota(c, {
          userId, searchId: sid, requestedLimit: 50, planLimit: 2500,
          periodStart, periodEnd, idempotencyKey: `${key}-${sid}`,
        });
        await c.query('COMMIT');
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        c.release();
      }
    }
    const out = await leadQuota.recoverOrphanedLeadHolds({ limit: 50 });
    assert.ok(out.checked >= 1);
    const deadHold = await pool.query(
      `SELECT status FROM lead_quota_holds WHERE search_id = $1`, [dead]
    );
    const liveHold = await pool.query(
      `SELECT status FROM lead_quota_holds WHERE search_id = $1`, [live]
    );
    assert.equal(deadHold.rows[0].status, 'released');
    assert.equal(liveHold.rows[0].status, 'held');
  });
});
