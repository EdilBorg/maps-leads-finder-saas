/**
 * Domain model (Etapa 5) — structure, multi-tenant isolation, integrity fixes (004/005).
 * Requires ALLOW_DB_TESTS=1 and a dedicated *_test database.
 */
try { require('dotenv').config(); } catch (_) {}
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

async function applyAllMigrations(pool) {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query(sql);
  }
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
  let searchB;
  let subA;
  let subB;

  before(async () => {
    assertSafeTestDatabase();
    ({ getPool, closePool } = require('../src/db/pool'));
    pool = getPool();

    await applyAllMigrations(pool);
    const sql4 = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '004_domain_integrity_fixes.sql'),
      'utf8'
    );
    await pool.query(sql4);
    const sql5 = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '005_domain_update_integrity.sql'),
      'utf8'
    );
    await pool.query(sql5);

    const hash = '$argon2id$v=19$m=65536,t=3,p=4$placeholder';
    const ins = await pool.query(
      `INSERT INTO users (email, email_normalized, password_hash, name)
       VALUES ($1, $2, $3, 'User A'), ($4, $5, $3, 'User B')
       RETURNING id`,
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

    const subs = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, status)
       VALUES ($1, $3, 'active'), ($2, $3, 'active')
       RETURNING id, user_id`,
      [userA, userB, planId]
    );
    subA = subs.rows.find((r) => r.user_id === userA).id;
    subB = subs.rows.find((r) => r.user_id === userB).id;

    const searches = await pool.query(
      `INSERT INTO searches (user_id, query, status)
       VALUES ($1, 'a-search', 'completed'), ($2, 'b-search', 'completed')
       RETURNING id, user_id`,
      [userA, userB]
    );
    searchA = searches.rows.find((r) => r.user_id === userA).id;
    searchB = searches.rows.find((r) => r.user_id === userB).id;
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
         AND table_name = ANY($1::text[])`,
      [[
        'plans', 'subscriptions', 'payments', 'searches', 'search_results',
        'saved_leads', 'api_providers', 'audit_logs', 'system_settings', 'users',
      ]]
    );
    assert.equal(rows.length, 10);
  });

  it('payment of A on subscription of A is accepted', async () => {
    const { rows } = await pool.query(
      `INSERT INTO payments (user_id, subscription_id, plan_id, amount_cents, status, idempotency_key)
       VALUES ($1, $2, $3, 100, 'pending', $4)
       RETURNING id`,
      [userA, subA, planId, `ok-a-${uuid()}`]
    );
    assert.ok(rows[0].id);
  });

  it('payment of A on subscription of B is rejected', async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO payments (user_id, subscription_id, plan_id, amount_cents, status, idempotency_key)
           VALUES ($1, $2, $3, 100, 'pending', $4)`,
          [userA, subB, planId, `bad-ab-${uuid()}`]
        ),
      /multi-tenant|check_violation|must match/i
    );
  });

  it('payment without subscription is accepted', async () => {
    const { rows } = await pool.query(
      `INSERT INTO payments (user_id, plan_id, amount_cents, status, idempotency_key)
       VALUES ($1, $2, 50, 'pending', $3)
       RETURNING subscription_id`,
      [userA, planId, `nosub-${uuid()}`]
    );
    assert.equal(rows[0].subscription_id, null);
  });

  it('saved lead of A linked to search of A is accepted', async () => {
    const { rows } = await pool.query(
      `INSERT INTO saved_leads (user_id, origin_search_id, name, snapshot)
       VALUES ($1, $2, 'OK', '{}'::jsonb)
       RETURNING id`,
      [userA, searchA]
    );
    assert.ok(rows[0].id);
  });

  it('saved lead of A linked to search of B is rejected', async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO saved_leads (user_id, origin_search_id, name, snapshot)
           VALUES ($1, $2, 'Bad', '{}'::jsonb)`,
          [userA, searchB]
        ),
      /multi-tenant|check_violation|must match/i
    );
  });

  it('deleting search nulls origin_search_id but keeps snapshot', async () => {
    const s = await pool.query(
      `INSERT INTO searches (user_id, query, status) VALUES ($1, 'snap-del', 'completed') RETURNING id`,
      [userA]
    );
    const sid = s.rows[0].id;
    const lead = await pool.query(
      `INSERT INTO saved_leads (user_id, origin_search_id, name, snapshot)
       VALUES ($1, $2, 'Keep', '{"x":1}'::jsonb)
       RETURNING id`,
      [userA, sid]
    );
    await pool.query(`DELETE FROM searches WHERE id = $1`, [sid]);
    const { rows } = await pool.query(
      `SELECT origin_search_id, name, snapshot FROM saved_leads WHERE id = $1`,
      [lead.rows[0].id]
    );
    assert.equal(rows[0].origin_search_id, null);
    assert.equal(rows[0].name, 'Keep');
    assert.equal(rows[0].snapshot.x, 1);
  });

  it('result on own search is accepted', async () => {
    const { rows } = await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id)
       VALUES ($1, $2, 'R1', 'demo', 'e1')
       RETURNING id`,
      [searchA, userA]
    );
    assert.ok(rows[0].id);
  });

  it('duplicate reference within same search is accepted', async () => {
    const a = await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id)
       VALUES ($1, $2, 'Orig', 'demo', $3) RETURNING id`,
      [searchA, userA, `o-${uuid()}`]
    );
    const b = await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id, is_duplicate_of)
       VALUES ($1, $2, 'Dup', 'demo', $3, $4) RETURNING is_duplicate_of`,
      [searchA, userA, `d-${uuid()}`, a.rows[0].id]
    );
    assert.equal(b.rows[0].is_duplicate_of, a.rows[0].id);
  });

  it('duplicate reference to another search is rejected', async () => {
    const onB = await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id)
       VALUES ($1, $2, 'B-only', 'demo', $3) RETURNING id`,
      [searchB, userB, `b-${uuid()}`]
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO search_results (search_id, user_id, name, source_provider, is_duplicate_of)
           VALUES ($1, $2, 'Cross', 'demo', $3)`,
          [searchA, userA, onB.rows[0].id]
        ),
      /multi-tenant|same search|check_violation/i
    );
  });

  it('duplicate reference to another user is rejected', async () => {
    const onB = await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id)
       VALUES ($1, $2, 'B2', 'demo', $3) RETURNING id`,
      [searchB, userB, `b2-${uuid()}`]
    );
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO search_results (search_id, user_id, name, source_provider, is_duplicate_of)
           VALUES ($1, $2, 'Steal', 'demo', $3)`,
          [searchA, userA, onB.rows[0].id]
        ),
      /multi-tenant|same search|check_violation/i
    );
  });

  it('deleting search cascades search_results', async () => {
    const s = await pool.query(
      `INSERT INTO searches (user_id, query, status) VALUES ($1, 'casc', 'completed') RETURNING id`,
      [userA]
    );
    const sid = s.rows[0].id;
    await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider)
       VALUES ($1, $2, 'Tmp', 'demo')`,
      [sid, userA]
    );
    await pool.query(`DELETE FROM searches WHERE id = $1`, [sid]);
    const { rows } = await pool.query(`SELECT id FROM search_results WHERE search_id = $1`, [sid]);
    assert.equal(rows.length, 0);
  });

  it('rejects attaching search_results to another user search', async () => {
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

  it('migrations 001-005 remain applied and integrity SQL is re-runnable', async () => {
    const sql5 = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '005_domain_update_integrity.sql'),
      'utf8'
    );
    await pool.query(sql5);
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_proc WHERE proname = 'enforce_subscription_user_change_safe'`
    );
    assert.equal(rows.length, 1);
  });

  it('rejects changing subscription owner when payments reference it', async () => {
    const sub = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, 'active') RETURNING id`,
      [userA, planId]
    );
    await pool.query(
      `INSERT INTO payments (user_id, subscription_id, plan_id, amount_cents, status, idempotency_key)
       VALUES ($1, $2, $3, 10, 'pending', $4)`,
      [userA, sub.rows[0].id, planId, `upd-sub-${uuid()}`]
    );
    await assert.rejects(
      () => pool.query(`UPDATE subscriptions SET user_id = $1 WHERE id = $2`, [userB, sub.rows[0].id]),
      /multi-tenant|cannot change|check_violation/i
    );
  });

  it('rejects changing search owner when saved_leads reference it', async () => {
    const s = await pool.query(
      `INSERT INTO searches (user_id, query, status) VALUES ($1, 'owned', 'completed') RETURNING id`,
      [userA]
    );
    await pool.query(
      `INSERT INTO saved_leads (user_id, origin_search_id, name, snapshot)
       VALUES ($1, $2, 'L', '{}'::jsonb)`,
      [userA, s.rows[0].id]
    );
    await assert.rejects(
      () => pool.query(`UPDATE searches SET user_id = $1 WHERE id = $2`, [userB, s.rows[0].id]),
      /multi-tenant|cannot change|check_violation/i
    );
  });

  it('rejects moving a result that is target of is_duplicate_of', async () => {
    const s = await pool.query(
      `INSERT INTO searches (user_id, query, status) VALUES ($1, 'dup-scope', 'completed') RETURNING id`,
      [userA]
    );
    const sid = s.rows[0].id;
    const orig = await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id)
       VALUES ($1, $2, 'O', 'demo', $3) RETURNING id`,
      [sid, userA, `o-${uuid()}`]
    );
    await pool.query(
      `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id, is_duplicate_of)
       VALUES ($1, $2, 'D', 'demo', $3, $4)`,
      [sid, userA, `d-${uuid()}`, orig.rows[0].id]
    );
    const s2 = await pool.query(
      `INSERT INTO searches (user_id, query, status) VALUES ($1, 'other', 'completed') RETURNING id`,
      [userA]
    );
    await assert.rejects(
      () =>
        pool.query(`UPDATE search_results SET search_id = $1 WHERE id = $2`, [
          s2.rows[0].id,
          orig.rows[0].id,
        ]),
      /multi-tenant|cannot change|is_duplicate_of|check_violation/i
    );
  });

  it('concurrent payment insert vs subscription owner change keeps invariant', async () => {
    const sub = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, 'active') RETURNING id`,
      [userA, planId]
    );
    const sid = sub.rows[0].id;
    const client1 = await pool.connect();
    const client2 = await pool.connect();
    try {
      await client1.query('BEGIN');
      await client2.query('BEGIN');
      await client1.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [sid]);
      const insertPromise = client2.query(
        `INSERT INTO payments (user_id, subscription_id, plan_id, amount_cents, status, idempotency_key)
         VALUES ($1, $2, $3, 1, 'pending', $4)`,
        [userA, sid, planId, `race-${uuid()}`]
      );
      await new Promise((r) => setTimeout(r, 50));
      try {
        await client1.query(`UPDATE subscriptions SET user_id = $1 WHERE id = $2`, [userB, sid]);
        await client1.query('COMMIT');
      } catch (e) {
        await client1.query('ROLLBACK').catch(() => {});
      }
      try {
        await insertPromise;
        await client2.query('COMMIT');
      } catch (e) {
        await client2.query('ROLLBACK').catch(() => {});
      }
      const { rows: subRows } = await pool.query(`SELECT user_id FROM subscriptions WHERE id = $1`, [sid]);
      const { rows: payRows } = await pool.query(
        `SELECT user_id FROM payments WHERE subscription_id = $1`,
        [sid]
      );
      for (const p of payRows) {
        assert.equal(p.user_id, subRows[0].user_id);
      }
      assert.ok(subRows[0]);
    } finally {
      client1.release();
      client2.release();
    }
  });
});
