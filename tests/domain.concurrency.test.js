/**
 * Multi-tenant concurrency (Etapa 5) — deterministic lock tests.
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

/**
 * Wait until backend waitingPid is blocked by blockerPid using pg_blocking_pids.
 */
async function waitUntilBlocked(observerPool, waitingPid, blockerPid, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await observerPool.query(
      `SELECT pg_blocking_pids($1::int) AS blockers`,
      [waitingPid]
    );
    const blockers = (rows[0]?.blockers || []).map(Number);
    if (blockers.includes(Number(blockerPid))) {
      return blockers;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timeout waiting for pid ${waitingPid} to be blocked by ${blockerPid}`);
}

async function applyAllMigrations(pool) {
  const dir = path.join(__dirname, '..', 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
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
    await applyAllMigrations(pool);

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

  it('payment insert vs subscription owner change: lock + final invariant', async () => {
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
            insertOutcome = { ok: false, message: err.message };
          }
        );

      await waitUntilBlocked(pool, pid2, pid1);

      try {
        await c1.query(`UPDATE subscriptions SET user_id = $1 WHERE id = $2`, [userB, sid]);
        await c1.query('COMMIT');
        updateOutcome = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        updateOutcome = { ok: false, message: err.message };
      }

      await insertPromise;
      if (insertOutcome?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          insertOutcome = { ok: false, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.ok(insertOutcome, 'insert outcome recorded');
      assert.ok(updateOutcome, 'update outcome recorded');

      const { rows: bad } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payments p
         JOIN subscriptions s ON s.id = p.subscription_id
         WHERE p.subscription_id = $1 AND p.user_id IS DISTINCT FROM s.user_id`,
        [sid]
      );
      assert.equal(bad[0].n, 0);
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('saved_lead insert vs search owner change: lock + final invariant', async () => {
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
            leadOutcome = { ok: false, message: err.message };
          }
        );

      await waitUntilBlocked(pool, pid2, pid1);

      try {
        await c1.query(`UPDATE searches SET user_id = $1 WHERE id = $2`, [userB, sid]);
        await c1.query('COMMIT');
        updateOutcome = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        updateOutcome = { ok: false, message: err.message };
      }

      await leadPromise;
      if (leadOutcome?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          leadOutcome = { ok: false, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.ok(leadOutcome);
      assert.ok(updateOutcome);

      const { rows: bad } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM saved_leads sl
         JOIN searches s ON s.id = sl.origin_search_id
         WHERE sl.origin_search_id = $1 AND sl.user_id IS DISTINCT FROM s.user_id`,
        [sid]
      );
      assert.equal(bad[0].n, 0);
    } finally {
      try { await c1.query('ROLLBACK'); } catch (_) {}
      try { await c2.query('ROLLBACK'); } catch (_) {}
      c1.release();
      c2.release();
    }
  });

  it('is_duplicate_of insert vs moving target: lock + final invariant', async () => {
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
            dupOutcome = { ok: false, message: err.message };
          }
        );

      await waitUntilBlocked(pool, pid2, pid1);

      try {
        await c1.query(`UPDATE search_results SET search_id = $1 WHERE id = $2`, [sid2, tid]);
        await c1.query('COMMIT');
        moveOutcome = { ok: true };
      } catch (err) {
        await c1.query('ROLLBACK').catch(() => {});
        moveOutcome = { ok: false, message: err.message };
      }

      await dupPromise;
      if (dupOutcome?.ok) {
        try {
          await c2.query('COMMIT');
        } catch (err) {
          dupOutcome = { ok: false, message: err.message };
          await c2.query('ROLLBACK').catch(() => {});
        }
      } else {
        await c2.query('ROLLBACK').catch(() => {});
      }

      assert.ok(dupOutcome);
      assert.ok(moveOutcome);

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
});
