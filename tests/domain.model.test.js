/**
 * Domain model (Etapa 5) — structure, constraints, multi-tenant isolation.
 * Requires ALLOW_DB_TESTS=1 and a dedicated *_test database.
 */
require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');

const hasDb = shouldRunDbIntegration();

function uuid() {
  return crypto.randomUUID();
}

describe('domain model schema & multi-tenant isolation', { skip: !hasDb }, () => {
  let getPool;
  let closePool;
  let pool;
  const emailA = `dom_a_${Date.now()}@example.com`;
  const emailB = `dom_b_${Date.now()}@example.com`;
  let userA;
  let userB;
  let planId;
  let searchA;

  before(async () => {
    assertSafeTestDatabase();
    ({ getPool, closePool } = require('../src/db/pool'));
    pool = getPool();

    for (const file of ['001_auth.sql', '002_fix_session_oids.sql', '003_domain_model.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', file), 'utf8');
      await pool.query(sql);
    }
    const sql3 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '003_domain_model.sql'), 'utf8');
    await pool.query(sql3);

    const hash = '$argon2id$v=19$m=65536,t=3,p=4$placeholder';
    const ins = await pool.query(
      `INSERT INTO users (email, email_normalized, password_hash, name)
       VALUES ($1, $2, $3, 'User A'), ($4, $5, $3, 'User B')
       RETURNING id, email_normalized`,
      [emailA, emailA.toLowerCase(), hash, emailB, emailB.toLowerCase()]
    );
    userA = ins.rows[0].id;
    userB = ins.rows[1].id;

    const plan = await pool.query(
      `INSERT INTO plans (name, price_cents, max_searches_per_month, max_results_per_month, max_results_per_search)
       VALUES ('test-plan-' || $1::text, 0, 10, 1000, 200)
       RETURNING id`,
      [String(Date.now())]
    );
    planId = plan.rows[0].id;
  });

  after(async () => {
    try {
      await pool.query(`DELETE FROM users WHERE email_normalized IN ($1, $2)`, [
        emailA.toLowerCase(),
        emailB.toLowerCase(),
      ]);
      await pool.query(`DELETE FROM plans WHERE id = $1`, [planId]);
    } catch (_) {}
    try {
      await closePool();
    } catch (_) {}
  });

  it('creates expected domain tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [[
        'plans', 'subscriptions', 'payments', 'searches', 'search_results',
        'saved_leads', 'api_providers', 'audit_logs', 'system_settings', 'users',
      ]]
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'plans', 'subscriptions', 'payments', 'searches', 'search_results',
      'saved_leads', 'api_providers', 'audit_logs', 'system_settings', 'users',
    ]) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
  });

  it('rejects invalid subscription status', async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, 'bogus')`,
          [userA, planId]
        ),
      /check|violates/i
    );
  });

  it('creates search owned by user A', async () => {
    const { rows } = await pool.query(
      `INSERT INTO searches (user_id, query, location, status)
       VALUES ($1, 'cafes', 'Maputo', 'completed')
       RETURNING id, user_id`,
      [userA]
    );
    searchA = rows[0].id;
    assert.equal(rows[0].user_id, userA);
  });

  it('allows search_results only when user_id matches search owner', async () => {
    const { rows } = await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id)
       VALUES ($1, $2, 'Lead A', 'demo', 'ext-1')
       RETURNING id`,
      [searchA, userA]
    );
    assert.ok(rows[0].id);
  });

  it('rejects search_results attached to another user search', async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO search_results (search_id, user_id, name, source_provider)
           VALUES ($1, $2, 'Stolen', 'demo')`,
          [searchA, userB]
        ),
      /foreign key|violates/i
    );
  });

  it('isolates searches between users', async () => {
    await pool.query(
      `INSERT INTO searches (user_id, query, status) VALUES ($1, 'only-b', 'pending')`,
      [userB]
    );
    const { rows: onlyA } = await pool.query(`SELECT id FROM searches WHERE user_id = $1`, [userA]);
    const { rows: onlyB } = await pool.query(`SELECT id FROM searches WHERE user_id = $1`, [userB]);
    assert.ok(onlyB.length >= 1);
    const aIds = new Set(onlyA.map((r) => r.id));
    for (const r of onlyB) {
      assert.equal(aIds.has(r.id), false);
    }
  });

  it('saved_leads snapshot survives search deletion', async () => {
    const search = await pool.query(
      `INSERT INTO searches (user_id, query, status) VALUES ($1, 'snap', 'completed') RETURNING id`,
      [userA]
    );
    const sid = search.rows[0].id;
    const lead = await pool.query(
      `INSERT INTO saved_leads (user_id, origin_search_id, name, snapshot, notes)
       VALUES ($1, $2, 'Snap Lead', '{"name":"Snap Lead"}'::jsonb, 'keep')
       RETURNING id`,
      [userA, sid]
    );
    const leadId = lead.rows[0].id;
    await pool.query(`DELETE FROM searches WHERE id = $1`, [sid]);
    const { rows } = await pool.query(
      `SELECT id, origin_search_id, name FROM saved_leads WHERE id = $1`,
      [leadId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin_search_id, null);
    assert.equal(rows[0].name, 'Snap Lead');
  });

  it('deleting a search cascades search_results only', async () => {
    const s = await pool.query(
      `INSERT INTO searches (user_id, query, status) VALUES ($1, 'cascade', 'completed') RETURNING id`,
      [userA]
    );
    const sid = s.rows[0].id;
    await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider)
       VALUES ($1, $2, 'Temp', 'demo')`,
      [sid, userA]
    );
    await pool.query(`DELETE FROM searches WHERE id = $1`, [sid]);
    const { rows } = await pool.query(`SELECT id FROM search_results WHERE search_id = $1`, [sid]);
    assert.equal(rows.length, 0);
  });

  it('payment requires plan and supports pending status without subscription', async () => {
    const { rows } = await pool.query(
      `INSERT INTO payments (user_id, plan_id, amount_cents, status, idempotency_key)
       VALUES ($1, $2, 1000, 'pending', $3)
       RETURNING id, status, subscription_id`,
      [userA, planId, `idem-${uuid()}`]
    );
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].subscription_id, null);
  });

  it('rejects duplicate payment idempotency_key', async () => {
    const key = `idem-dup-${uuid()}`;
    await pool.query(
      `INSERT INTO payments (user_id, plan_id, amount_cents, status, idempotency_key)
       VALUES ($1, $2, 500, 'pending', $3)`,
      [userA, planId, key]
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO payments (user_id, plan_id, amount_cents, status, idempotency_key)
           VALUES ($1, $2, 500, 'pending', $3)`,
          [userA, planId, key]
        ),
      /unique|duplicate/i
    );
  });
});
