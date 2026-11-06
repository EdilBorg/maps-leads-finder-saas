/**
 * Multi-tenant concurrency (Etapa 5) — deterministic lock tests with explicit outcomes.
 * Requires ALLOW_DB_TESTS=1 and a dedicated *_test database.
 */
try { require('dotenv').config(); } catch (_) {}
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');
const { applyMigrationsOnce } = require('./helpers/applyMigrationsOnce');

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
  throw new Error(`Timeout waiting for pid ${waitingPid} to be blocked by ${blockerPid}`);
}

function isIntegrityReject(err) {
  const code = err && (err.code || err.sqlState);
  return typeof code === 'string' && /^23/.test(code);
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
      await c1.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [sid]);

      await c2.query('BEGIN');
      const insertPromise = c2
        .query(
          `INSERT INTO payments (user_id, subscription_id, plan_id, amount_cents, status, idempotency_key)
           VALUES ($1, $2, $3, 1, 'pending', $4) RETURNING id`,
          [userA, sid, planId, `race-pay-${uuid()}`]
        )
        .then(
          (res) => {
            insertOutcome = { ok: true, id: res.rows[0].id };
          },
          (err) => {
            insertOutcome = { ok: false, code: err.code, message: err.message };
          }
        );

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

      assert.equal(updateOutcome.ok, true, `subscription owner UPDATE must succeed: ${updateOutcome.message || ''}`);
      assert.equal(insertOutcome.ok, false, 'payment INSERT for old owner must be rejected');
      assert.ok(
        isIntegrityReject(insertOutcome) || /multi-tenant|must match/i.test(insertOutcome.message || ''),
        `expected integrity reject, got code=${insertOutcome.code} msg=${insertOutcome.message}`
      );

      const { rows: sub } = await pool.query(`SELECT user_id FROM subscriptions WHERE id = $1`, [sid]);
      assert.equal(sub[0].user_id, userB);
      const { rows: pays } = await pool.query(`SELECT id FROM payments WHERE subscription_id = $1`, [sid]);
      assert.equal(pays.length, 0);
      const { rows: bad } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payments p
         JOIN subscriptions s ON s.id = p.subscription_id
         WHERE p.user_id IS DISTINCT FROM s.user_id`
      );
      assert.equal(bad[0].n, 0);
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
        `INSERT INTO searches (user_id, query, status) VALUES ($1, 'race-s', 'completed') RETURNING id`,
        [userA]
      )
    ).rows[0].id;

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let leadOutcome = null;
    let updateOutcome = null;
    try {
      const pid1 = (await c1.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const pid2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p;

      await c1.query('BEGIN');
      await c1.query(`SELECT id FROM searches WHERE id = $1 FOR UPDATE`, [sid]);

      await c2.query('BEGIN');
      const leadPromise = c2
        .query(
          `INSERT INTO saved_leads (user_id, origin_search_id, name, snapshot)
           VALUES ($1, $2, 'RaceLead', '{}'::jsonb) RETURNING id`,
          [userA, sid]
        )
        .then(
          (res) => {
            leadOutcome = { ok: true, id: res.rows[0].id };
          },
          (err) => {
            leadOutcome = { ok: false, code: err.code, message: err.message };
          }
        );

      await waitUntilBlocked(pool, pid2, pid1);

      try {
        await c1.query(`UPDATE searches SET user_id = $1 WHERE id = $2`, [userB, sid]);
        await c1.query('COMMIT');
        updateOutcome = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        updateOutcome = { ok: false, code: err.code, message: err.message };
      }

      await leadPromise;
      if (leadOutcome?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          leadOutcome = { ok: false, code: err.code, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.equal(updateOutcome.ok, true, `search owner UPDATE must succeed: ${updateOutcome.message || ''}`);
      assert.equal(leadOutcome.ok, false, 'saved_lead INSERT for old owner must be rejected');
      assert.ok(
        isIntegrityReject(leadOutcome) || /multi-tenant|must match/i.test(leadOutcome.message || ''),
        `expected integrity reject, got code=${leadOutcome.code} msg=${leadOutcome.message}`
      );

      const { rows: s } = await pool.query(`SELECT user_id FROM searches WHERE id = $1`, [sid]);
      assert.equal(s[0].user_id, userB);
      const { rows: bad } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM saved_leads sl
         JOIN searches se ON se.id = sl.origin_search_id
         WHERE sl.user_id IS DISTINCT FROM se.user_id`
      );
      assert.equal(bad[0].n, 0);
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('is_duplicate_of INSERT vs target scope UPDATE: move wins, duplicate rejected', async () => {
    const sid = (
      await pool.query(
        `INSERT INTO searches (user_id, query, status) VALUES ($1, 'dup-race', 'completed') RETURNING id`,
        [userA]
      )
    ).rows[0].id;
    const tid = (
      await pool.query(
        `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id)
         VALUES ($1, $2, 'Target', 'demo', $3) RETURNING id`,
        [sid, userA, `tgt-${uuid()}`]
      )
    ).rows[0].id;
    const sid2 = (
      await pool.query(
        `INSERT INTO searches (user_id, query, status) VALUES ($1, 'dup-race-2', 'completed') RETURNING id`,
        [userA]
      )
    ).rows[0].id;

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let dupOutcome = null;
    let moveOutcome = null;
    try {
      const pid1 = (await c1.query('SELECT pg_backend_pid() AS p')).rows[0].p;
      const pid2 = (await c2.query('SELECT pg_backend_pid() AS p')).rows[0].p;

      await c1.query('BEGIN');
      await c1.query(`SELECT id FROM search_results WHERE id = $1 FOR UPDATE`, [tid]);

      await c2.query('BEGIN');
      const dupPromise = c2
        .query(
          `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id, is_duplicate_of)
           VALUES ($1, $2, 'DupRace', 'demo', $3, $4) RETURNING id`,
          [sid, userA, `dup-${uuid()}`, tid]
        )
        .then(
          (res) => {
            dupOutcome = { ok: true, id: res.rows[0].id };
          },
          (err) => {
            dupOutcome = { ok: false, code: err.code, message: err.message };
          }
        );

      await waitUntilBlocked(pool, pid2, pid1);

      try {
        await c1.query(`UPDATE search_results SET search_id = $1 WHERE id = $2`, [sid2, tid]);
        await c1.query('COMMIT');
        moveOutcome = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        moveOutcome = { ok: false, code: err.code, message: err.message };
      }

      await dupPromise;
      if (dupOutcome?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          dupOutcome = { ok: false, code: err.code, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.equal(moveOutcome.ok, true, `target scope UPDATE must succeed: ${moveOutcome.message || ''}`);
      assert.equal(dupOutcome.ok, false, 'duplicate INSERT must be rejected after target moved');
      assert.ok(
        isIntegrityReject(dupOutcome) || /multi-tenant|same search/i.test(dupOutcome.message || ''),
        `expected integrity reject, got code=${dupOutcome.code} msg=${dupOutcome.message}`
      );

      const { rows: bad } = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM search_results r
         JOIN search_results d ON d.id = r.is_duplicate_of
         WHERE r.is_duplicate_of IS NOT NULL
           AND (r.search_id IS DISTINCT FROM d.search_id OR r.user_id IS DISTINCT FROM d.user_id)`
      );
      assert.equal(bad[0].n, 0);
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
      await c1.query(`SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE`, [sid]);

      await c2.query('BEGIN');
      const payPromise = c2
        .query(`UPDATE payments SET user_id = $1 WHERE id = $2`, [userB, payId])
        .then(
          () => {
            payUpd = { ok: true };
          },
          (err) => {
            payUpd = { ok: false, code: err.code, message: err.message };
          }
        );

      try {
        await waitUntilBlocked(pool, pid2, pid1, 3000);
      } catch (_) {}

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

      if (subUpd && subUpd.code === '40P01') {
        assert.fail(`deadlock 40P01 on subscription update: ${subUpd.message}`);
      }
      if (payUpd && payUpd.code === '40P01') {
        assert.fail(`deadlock 40P01 on payment update: ${payUpd.message}`);
      }

      const { rows: bad } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payments p
         JOIN subscriptions s ON s.id = p.subscription_id
         WHERE p.subscription_id IS NOT NULL AND p.user_id IS DISTINCT FROM s.user_id`
      );
      assert.equal(bad[0].n, 0, 'cross-tenant payment/subscription after UPDATE race');
      assert.ok(subUpd && payUpd, 'both outcomes recorded');
      const { rows: pay } = await pool.query(`SELECT user_id, subscription_id FROM payments WHERE id = $1`, [payId]);
      const { rows: sub } = await pool.query(`SELECT user_id FROM subscriptions WHERE id = $1`, [sid]);
      if (pay[0].subscription_id) {
        assert.equal(pay[0].user_id, sub[0].user_id);
      }
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
        `INSERT INTO searches (user_id, query, status) VALUES ($1, 's1', 'completed') RETURNING id`,
        [userA]
      )
    ).rows[0].id;
    const s2 = (
      await pool.query(
        `INSERT INTO searches (user_id, query, status) VALUES ($1, 's2', 'completed') RETURNING id`,
        [userB]
      )
    ).rows[0].id;
    const leadId = (
      await pool.query(
        `INSERT INTO saved_leads (user_id, origin_search_id, name, snapshot)
         VALUES ($1, $2, 'L', '{}'::jsonb) RETURNING id`,
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
      await c1.query(`SELECT id FROM searches WHERE id = $1 FOR UPDATE`, [s1]);

      await c2.query('BEGIN');
      const leadPromise = c2
        .query(`UPDATE saved_leads SET origin_search_id = $1 WHERE id = $2`, [s2, leadId])
        .then(
          () => {
            leadUpd = { ok: true };
          },
          (err) => {
            leadUpd = { ok: false, code: err.code, message: err.message };
          }
        );

      try {
        await waitUntilBlocked(pool, pid2, pid1, 3000);
      } catch (_) {}

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

      if (searchUpd?.code === '40P01' || leadUpd?.code === '40P01') {
        assert.fail('unexpected deadlock 40P01');
      }

      const { rows: bad } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM saved_leads sl
         JOIN searches se ON se.id = sl.origin_search_id
         WHERE sl.origin_search_id IS NOT NULL AND sl.user_id IS DISTINCT FROM se.user_id`
      );
      assert.equal(bad[0].n, 0);
      assert.equal(leadUpd.ok, false, 'cross-tenant origin_search_id UPDATE must be rejected');
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('is_duplicate_of UPDATE vs target scope UPDATE preserves invariant', async () => {
    const sid = (
      await pool.query(
        `INSERT INTO searches (user_id, query, status) VALUES ($1, 'd1', 'completed') RETURNING id`,
        [userA]
      )
    ).rows[0].id;
    const sid2 = (
      await pool.query(
        `INSERT INTO searches (user_id, query, status) VALUES ($1, 'd2', 'completed') RETURNING id`,
        [userA]
      )
    ).rows[0].id;
    const t1 = (
      await pool.query(
        `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id)
         VALUES ($1, $2, 'T1', 'demo', $3) RETURNING id`,
        [sid, userA, `t1-${uuid()}`]
      )
    ).rows[0].id;
    const t2 = (
      await pool.query(
        `INSERT INTO search_results (search_id, user_id, name, source_provider, external_id)
         VALUES ($1, $2, 'T2', 'demo', $3) RETURNING id`,
        [sid, userA, `t2-${uuid()}`]
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
      await c1.query(`SELECT id FROM search_results WHERE id = $1 FOR UPDATE`, [t1]);

      await c2.query('BEGIN');
      const dupPromise = c2
        .query(`UPDATE search_results SET is_duplicate_of = $1 WHERE id = $2`, [t1, t2])
        .then(
          () => {
            dupOut = { ok: true };
          },
          (err) => {
            dupOut = { ok: false, code: err.code, message: err.message };
          }
        );

      try {
        await waitUntilBlocked(pool, pid2, pid1, 3000);
      } catch (_) {}

      try {
        await c1.query(`UPDATE search_results SET search_id = $1 WHERE id = $2`, [sid2, t1]);
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

      if (moveOut?.code === '40P01' || dupOut?.code === '40P01') {
        assert.fail('unexpected deadlock 40P01');
      }

      const { rows: bad } = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM search_results r
         JOIN search_results d ON d.id = r.is_duplicate_of
         WHERE r.is_duplicate_of IS NOT NULL
           AND (r.search_id IS DISTINCT FROM d.search_id OR r.user_id IS DISTINCT FROM d.user_id)`
      );
      assert.equal(bad[0].n, 0);
      if (moveOut.ok) {
        assert.equal(dupOut.ok, false, 'is_duplicate_of to moved target must be rejected');
      }
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });
});
