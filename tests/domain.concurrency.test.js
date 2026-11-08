/**
 * Multi-tenant concurrency (Etapa 5) — deterministic lock tests with explicit outcomes.
 * Requires ALLOW_DB_TESTS=1 and a dedicated *_test database.
 *
 * Strategy: acquire tenant advisory locks (src/db/tenantLocks.js) BEFORE row locks,
 * in a global deterministic order, matching docs/DOMAIN_MODEL.md and migration 007.
 * Triggers still enforce integrity; 40P01 is a hard failure for these scenarios.
 *
 * Migration 005: owner/scope changes are rejected when dependents already exist.
 */

try {
  require('dotenv').config();
} catch (_) {}
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');
const { applyMigrationsOnce } = require('./helpers/applyMigrationsOnce');
const {
  lockSubscription,
  lockSearch,
  lockSearchResult,
} = require('../src/db/tenantLocks');

const hasDb = shouldRunDbIntegration();

function uuid() {
  return crypto.randomUUID();
}

async function waitUntilBlocked(observerPool, waitingPid, blockerPid, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await observerPool.query(
      `SELECT pg_blocking_pids($1::int) AS blockers`,
      [waitingPid]
    );
    const blockers = (rows[0]?.blockers || []).map(Number);
    if (blockers.includes(Number(blockerPid))) return blockers;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(
    `Synchronization failed: pid ${waitingPid} was not blocked by ${blockerPid} within ${timeoutMs}ms (expected lock contention)`
  );
}

function isIntegrityReject(err) {
  const code = err && (err.code || err.sqlState);
  return typeof code === 'string' && /^23/.test(code);
}

function isRejectOutcome(out) {
  if (!out || out.ok) return false;
  return isIntegrityReject(out) || /multi-tenant|must match|cannot change/i.test(out.message || '');
}

describe('domain concurrency multi-tenant', { skip: !hasDb }, () => {
  let getPool;
  let closePool;
  let pool;
  const emailA = `conc_a_${Date.now()}@example.com`;
  const emailB = `conc_b_${Date.now()}@example.com`;
  let userA;
  let userB;
  let planId;

  before(async () => {
    assertSafeTestDatabase();
    ({ getPool, closePool } = require('../src/db/pool'));
    pool = getPool();
    await applyMigrationsOnce(pool);

    const hash = '$argon2id$v=19$m=65536,t=3,p=4$placeholder';
    const ins = await pool.query(
      `INSERT INTO users (email, email_normalized, password_hash, name)
       VALUES ($1, $2, $3, 'A'), ($4, $5, $3, 'B') RETURNING id`,
      [emailA, emailA.toLowerCase(), hash, emailB, emailB.toLowerCase()]
    );
    userA = ins.rows[0].id;
    userB = ins.rows[1].id;
    planId = (
      await pool.query(
        `INSERT INTO plans (name, price_cents, max_searches_per_month, max_results_per_month, max_results_per_search)
         VALUES ($1, 0, 10, 1000, 200) RETURNING id`,
        [`conc-plan-${Date.now()}`]
      )
    ).rows[0].id;
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

  it('payment INSERT vs subscription owner UPDATE: owner change wins, payment rejected', async () => {
    const sid = (
      await pool.query(
        `INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, 'active') RETURNING id`,
        [userA, planId]
      )
    ).rows[0].id;

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let insertOutcome = null;
    let updateOutcome = null;
    try {
      const pid1 = (await c1.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const pid2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p;

      await c1.query('BEGIN');
      await lockSubscription(c1, sid);
      await c1.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [sid]);

      await c2.query('BEGIN');
      const insertPromise = (async () => {
        try {
          await lockSubscription(c2, sid);
          const res = await c2.query(
            `INSERT INTO payments (user_id, subscription_id, plan_id, amount_cents, status, idempotency_key)
             VALUES ($1, $2, $3, 1, 'pending', $4) RETURNING id`,
            [userA, sid, planId, `race-pay-${uuid()}`]
          );
          insertOutcome = { ok: true, id: res.rows[0].id };
        } catch (err) {
          insertOutcome = { ok: false, code: err.code, message: err.message };
        }
      })();

      await waitUntilBlocked(pool, pid2, pid1);

      try {
        await c1.query(`UPDATE subscriptions SET user_id = $1 WHERE id = $2`, [userB, sid]);
        await c1.query('COMMIT');
        updateOutcome = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        updateOutcome = { ok: false, code: err.code, message: err.message };
      }

      await insertPromise;
      if (insertOutcome?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          insertOutcome = { ok: false, code: err.code, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.notEqual(updateOutcome?.code, '40P01', 'deadlock on subscription update');
      assert.notEqual(insertOutcome?.code, '40P01', 'deadlock on payment insert');
      assert.equal(
        updateOutcome.ok,
        true,
        `subscription owner UPDATE must succeed with no dependents: ${updateOutcome.message || ''}`
      );
      assert.equal(insertOutcome.ok, false, 'payment INSERT for old owner must be rejected');
      assert.ok(
        isRejectOutcome(insertOutcome),
        `expected integrity reject, got code=${insertOutcome.code} msg=${insertOutcome.message}`
      );

      const { rows: sub } = await pool.query(`SELECT user_id FROM subscriptions WHERE id = $1`, [sid]);
      assert.equal(sub[0].user_id, userB);
      const { rows: pays } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payments WHERE subscription_id = $1 AND user_id = $2`,
        [sid, userA]
      );
      assert.equal(pays[0].n, 0);
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('saved_lead INSERT vs search owner UPDATE: owner change wins, lead rejected', async () => {
    const sid = (
      await pool.query(
        `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
         VALUES ($1, 'q', 'loc', '{}'::jsonb, 'completed', '[]'::jsonb, NOW(), NOW() + interval '30 days')
         RETURNING id`,
        [userA]
      )
    ).rows[0].id;

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let insertOutcome = null;
    let updateOutcome = null;
    try {
      const pid1 = (await c1.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const pid2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p;

      await c1.query('BEGIN');
      await lockSearch(c1, sid);
      await c1.query(`SELECT id FROM searches WHERE id = $1 FOR UPDATE`, [sid]);

      await c2.query('BEGIN');
      const insertPromise = (async () => {
        try {
          await lockSearch(c2, sid);
          const res = await c2.query(
            `INSERT INTO saved_leads (
               user_id, origin_search_id, name, address, phone, email, website,
               rating, reviews_count, category, lat, lng, source_provider, external_id, snapshot
             ) VALUES ($1, $2, 'Lead', null, null, null, null, null, null, null, null, null, 't', 'x', '{}'::jsonb)
             RETURNING id`,
            [userA, sid]
          );
          insertOutcome = { ok: true, id: res.rows[0].id };
        } catch (err) {
          insertOutcome = { ok: false, code: err.code, message: err.message };
        }
      })();

      await waitUntilBlocked(pool, pid2, pid1);

      try {
        await c1.query(`UPDATE searches SET user_id = $1 WHERE id = $2`, [userB, sid]);
        await c1.query('COMMIT');
        updateOutcome = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        updateOutcome = { ok: false, code: err.code, message: err.message };
      }

      await insertPromise;
      if (insertOutcome?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          insertOutcome = { ok: false, code: err.code, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.notEqual(updateOutcome?.code, '40P01');
      assert.notEqual(insertOutcome?.code, '40P01');
      assert.equal(updateOutcome.ok, true, `search owner UPDATE: ${updateOutcome.message || ''}`);
      assert.equal(insertOutcome.ok, false, 'saved_lead INSERT for old owner must be rejected');
      assert.ok(isRejectOutcome(insertOutcome));

      const { rows: s } = await pool.query(`SELECT user_id FROM searches WHERE id = $1`, [sid]);
      assert.equal(s[0].user_id, userB);
      const { rows: leads } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM saved_leads WHERE origin_search_id = $1 AND user_id = $2`,
        [sid, userA]
      );
      assert.equal(leads[0].n, 0);
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('is_duplicate_of INSERT vs target scope UPDATE: move wins, duplicate rejected', async () => {
    const s1 = (
      await pool.query(
        `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
         VALUES ($1, 'q1', 'loc', '{}'::jsonb, 'completed', '[]'::jsonb, NOW(), NOW() + interval '30 days')
         RETURNING id`,
        [userA]
      )
    ).rows[0].id;
    const s2 = (
      await pool.query(
        `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
         VALUES ($1, 'q2', 'loc', '{}'::jsonb, 'completed', '[]'::jsonb, NOW(), NOW() + interval '30 days')
         RETURNING id`,
        [userA]
      )
    ).rows[0].id;
    const tid = (
      await pool.query(
        `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id, raw_payload)
         VALUES ($1, $2, 'Target', 't', 't1', '{}'::jsonb) RETURNING id`,
        [s1, userA]
      )
    ).rows[0].id;

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let insertOutcome = null;
    let moveOutcome = null;
    try {
      const pid1 = (await c1.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const pid2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p;

      await c1.query('BEGIN');
      await lockSearchResult(c1, tid);
      await c1.query(`SELECT id FROM search_results WHERE id = $1 FOR UPDATE`, [tid]);

      await c2.query('BEGIN');
      const insertPromise = (async () => {
        try {
          await lockSearchResult(c2, tid);
          const res = await c2.query(
            `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id, raw_payload, is_duplicate_of)
             VALUES ($1, $2, 'Dup', 't', 'd1', '{}'::jsonb, $3) RETURNING id`,
            [s1, userA, tid]
          );
          insertOutcome = { ok: true, id: res.rows[0].id };
        } catch (err) {
          insertOutcome = { ok: false, code: err.code, message: err.message };
        }
      })();

      await waitUntilBlocked(pool, pid2, pid1);

      try {
        await c1.query(`UPDATE search_results SET search_id = $1 WHERE id = $2`, [s2, tid]);
        await c1.query('COMMIT');
        moveOutcome = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        moveOutcome = { ok: false, code: err.code, message: err.message };
      }

      await insertPromise;
      if (insertOutcome?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          insertOutcome = { ok: false, code: err.code, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.notEqual(moveOutcome?.code, '40P01');
      assert.notEqual(insertOutcome?.code, '40P01');
      assert.equal(moveOutcome.ok, true, `target move: ${moveOutcome.message || ''}`);
      assert.equal(insertOutcome.ok, false, 'duplicate INSERT after target moved must fail');
      assert.ok(isRejectOutcome(insertOutcome));

      const { rows: t } = await pool.query(`SELECT search_id FROM search_results WHERE id = $1`, [tid]);
      assert.equal(t[0].search_id, s2);
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('payment UPDATE vs subscription owner UPDATE preserves same-user invariant', async () => {
    const sid = (
      await pool.query(
        `INSERT INTO subscriptions (user_id, plan_id, status) VALUES ($1, $2, 'active') RETURNING id`,
        [userA, planId]
      )
    ).rows[0].id;
    const payId = (
      await pool.query(
        `INSERT INTO payments (user_id, subscription_id, plan_id, amount_cents, status, idempotency_key)
         VALUES ($1, $2, $3, 5, 'pending', $4) RETURNING id`,
        [userA, sid, planId, `upd-pay-${uuid()}`]
      )
    ).rows[0].id;

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let subUpd = null;
    let payUpd = null;
    try {
      const pid1 = (await c1.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const pid2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p;

      await c1.query('BEGIN');
      await lockSubscription(c1, sid);
      await c1.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [sid]);

      await c2.query('BEGIN');
      const payPromise = (async () => {
        try {
          await lockSubscription(c2, sid);
          await c2.query(`UPDATE payments SET user_id = $1 WHERE id = $2`, [userB, payId]);
          payUpd = { ok: true };
        } catch (err) {
          payUpd = { ok: false, code: err.code, message: err.message };
        }
      })();

      await waitUntilBlocked(pool, pid2, pid1, 10000);

      try {
        await c1.query(`UPDATE subscriptions SET user_id = $1 WHERE id = $2`, [userB, sid]);
        await c1.query('COMMIT');
        subUpd = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        subUpd = { ok: false, code: err.code, message: err.message };
      }

      await payPromise;
      if (payUpd?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          payUpd = { ok: false, code: err.code, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.notEqual(subUpd?.code, '40P01', 'deadlock on subscription update');
      assert.notEqual(payUpd?.code, '40P01', 'deadlock on payment update');

      assert.equal(subUpd.ok, false, 'owner change must be rejected when payment exists');
      assert.ok(isRejectOutcome(subUpd), `expected integrity reject on sub: ${subUpd.message}`);
      assert.equal(payUpd.ok, false, 'payment user_id change must be rejected');
      assert.ok(isRejectOutcome(payUpd), `expected integrity reject on pay: ${payUpd.message}`);

      const { rows: joined } = await pool.query(
        `SELECT p.user_id AS pu, s.user_id AS su
         FROM payments p JOIN subscriptions s ON s.id = p.subscription_id
         WHERE p.id = $1`,
        [payId]
      );
      assert.equal(joined[0].pu, joined[0].su);
      assert.equal(joined[0].pu, userA);
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('saved_lead origin UPDATE vs search owner UPDATE preserves invariant', async () => {
    const s1 = (
      await pool.query(
        `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
         VALUES ($1, 'q1', 'loc', '{}'::jsonb, 'completed', '[]'::jsonb, NOW(), NOW() + interval '30 days')
         RETURNING id`,
        [userA]
      )
    ).rows[0].id;
    const s2 = (
      await pool.query(
        `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
         VALUES ($1, 'q2', 'loc', '{}'::jsonb, 'completed', '[]'::jsonb, NOW(), NOW() + interval '30 days')
         RETURNING id`,
        [userB]
      )
    ).rows[0].id;
    const leadId = (
      await pool.query(
        `INSERT INTO saved_leads (
           user_id, origin_search_id, name, address, phone, email, website,
           rating, reviews_count, category, lat, lng, source_provider, external_id, snapshot
         ) VALUES ($1, $2, 'L', null, null, null, null, null, null, null, null, null, 't', 'e', '{}'::jsonb)
         RETURNING id`,
        [userA, s1]
      )
    ).rows[0].id;

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let searchUpd = null;
    let leadUpd = null;
    try {
      const pid1 = (await c1.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const pid2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p;

      await c1.query('BEGIN');
      await lockSearch(c1, s1);
      await c1.query(`SELECT id FROM searches WHERE id = $1 FOR UPDATE`, [s1]);

      await c2.query('BEGIN');
      const leadPromise = (async () => {
        try {
          await lockSearch(c2, s1);
          await c2.query(`UPDATE saved_leads SET origin_search_id = $1 WHERE id = $2`, [s2, leadId]);
          leadUpd = { ok: true };
        } catch (err) {
          leadUpd = { ok: false, code: err.code, message: err.message };
        }
      })();

      await waitUntilBlocked(pool, pid2, pid1, 10000);

      try {
        await c1.query(`UPDATE searches SET user_id = $1 WHERE id = $2`, [userB, s1]);
        await c1.query('COMMIT');
        searchUpd = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        searchUpd = { ok: false, code: err.code, message: err.message };
      }

      await leadPromise;
      if (leadUpd?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          leadUpd = { ok: false, code: err.code, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.notEqual(searchUpd?.code, '40P01');
      assert.notEqual(leadUpd?.code, '40P01');

      assert.equal(searchUpd.ok, false, 'search owner change blocked by dependent lead');
      assert.ok(isRejectOutcome(searchUpd));
      assert.equal(leadUpd.ok, false, 'cross-tenant origin_search_id must be rejected');
      assert.ok(isRejectOutcome(leadUpd));

      const { rows: row } = await pool.query(
        `SELECT l.user_id AS lu, s.user_id AS su
         FROM saved_leads l JOIN searches s ON s.id = l.origin_search_id
         WHERE l.id = $1`,
        [leadId]
      );
      assert.equal(row[0].lu, row[0].su);
      assert.equal(row[0].lu, userA);
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('is_duplicate_of UPDATE vs target scope UPDATE preserves invariant', async () => {
    const s1 = (
      await pool.query(
        `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
         VALUES ($1, 'q1', 'loc', '{}'::jsonb, 'completed', '[]'::jsonb, NOW(), NOW() + interval '30 days')
         RETURNING id`,
        [userA]
      )
    ).rows[0].id;
    const s2 = (
      await pool.query(
        `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
         VALUES ($1, 'q2', 'loc', '{}'::jsonb, 'completed', '[]'::jsonb, NOW(), NOW() + interval '30 days')
         RETURNING id`,
        [userA]
      )
    ).rows[0].id;
    const t1 = (
      await pool.query(
        `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id, raw_payload)
         VALUES ($1, $2, 'T1', 't', 't1', '{}'::jsonb) RETURNING id`,
        [s1, userA]
      )
    ).rows[0].id;
    const d1 = (
      await pool.query(
        `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id, raw_payload, is_duplicate_of)
         VALUES ($1, $2, 'D1', 't', 'd1', '{}'::jsonb, $3) RETURNING id`,
        [s1, userA, t1]
      )
    ).rows[0].id;

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let moveOut = null;
    let dupOut = null;
    try {
      const pid1 = (await c1.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const pid2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p;

      await c1.query('BEGIN');
      await lockSearchResult(c1, t1);
      await c1.query(`SELECT id FROM search_results WHERE id = $1 FOR UPDATE`, [t1]);

      await c2.query('BEGIN');
      const dupPromise = (async () => {
        try {
          await lockSearchResult(c2, t1);
          await c2.query(`UPDATE search_results SET is_duplicate_of = $1 WHERE id = $2`, [t1, d1]);
          dupOut = { ok: true };
        } catch (err) {
          dupOut = { ok: false, code: err.code, message: err.message };
        }
      })();

      await waitUntilBlocked(pool, pid2, pid1, 10000);

      try {
        await c1.query(`UPDATE search_results SET search_id = $1 WHERE id = $2`, [s2, t1]);
        await c1.query('COMMIT');
        moveOut = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        moveOut = { ok: false, code: err.code, message: err.message };
      }

      await dupPromise;
      if (dupOut?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          dupOut = { ok: false, code: err.code, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.notEqual(moveOut?.code, '40P01');
      assert.notEqual(dupOut?.code, '40P01');

      assert.equal(moveOut.ok, false, 'target scope change blocked while duplicates reference it');
      assert.ok(isRejectOutcome(moveOut));

      const { rows: bad } = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM search_results r
         JOIN search_results d ON d.id = r.is_duplicate_of
         WHERE r.is_duplicate_of IS NOT NULL
           AND (r.search_id IS DISTINCT FROM d.search_id OR r.user_id IS DISTINCT FROM d.user_id)`
      );
      assert.equal(bad[0].n, 0);

      const { rows: t } = await pool.query(`SELECT search_id FROM search_results WHERE id = $1`, [t1]);
      assert.equal(t[0].search_id, s1);
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });
});
