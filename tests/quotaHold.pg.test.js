/**
 * PostgreSQL integration — official scenarios A, B, F, G (+ extras).
 * Schema: migrations 008/009 only (no ALTER TABLE in tests).
 * Requires ALLOW_DB_TESTS=1 and a safe *_test database (testDbGuard).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunDbIntegration, assertSafeTestDatabase } = require('./helpers/testDbGuard');

const RUN = shouldRunDbIntegration();

describe('free search hold PostgreSQL integration', { skip: !RUN }, () => {
  let pool;
  let acquireFreeSearchHold;
  let consumeFreeSearchHold;
  let releaseFreeSearchHold;
  let renewFreeSearchHold;
  let recoverAbandonedSearches;

  before(async () => {
    assertSafeTestDatabase();
    const { getPool } = require('../src/db/pool');
    pool = getPool();
    ({
      acquireFreeSearchHold,
      consumeFreeSearchHold,
      releaseFreeSearchHold,
      renewFreeSearchHold,
      recoverAbandonedSearches,
    } = require('../src/services/freeSearchHold'));
  });

  after(async () => {
    if (pool && pool.end) await pool.end().catch(() => {});
  });

  async function createUser() {
    const email = `quota_${Date.now()}_${Math.random().toString(16).slice(2)}@test.local`;
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, email_verified, free_search_used)
       VALUES ($1, 'x', 'Quota Test', TRUE, FALSE) RETURNING id`,
      [email]
    );
    return rows[0].id;
  }

  async function cleanupUser(id) {
    await pool.query('DELETE FROM searches WHERE user_id = $1', [id]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }

  it('extra: first reservation creates token without consuming', async () => {
    const id = await createUser();
    try {
      const client = await pool.connect();
      try {
        const r = await acquireFreeSearchHold(client, id);
        assert.equal(r.allowed, true);
        const { rows } = await client.query(
          'SELECT free_search_used, free_search_hold_token FROM users WHERE id=$1', [id]
        );
        assert.equal(rows[0].free_search_used, false);
        assert.equal(rows[0].free_search_hold_token, r.holdToken);
      } finally { client.release(); }
    } finally { await cleanupUser(id); }
  });

  it('A [official]: concurrent acquire — only one wins for same user', async () => {
    const id = await createUser();
    try {
      const c1 = await pool.connect();
      const c2 = await pool.connect();
      try {
        const [a, b] = await Promise.all([
          acquireFreeSearchHold(c1, id),
          acquireFreeSearchHold(c2, id),
        ]);
        const allowed = [a, b].filter((x) => x.allowed);
        const denied = [a, b].filter((x) => !x.allowed);
        assert.equal(allowed.length, 1);
        assert.equal(denied.length, 1);
        assert.equal(denied[0].reason, 'FREE_SEARCH_IN_PROGRESS');
      } finally { c1.release(); c2.release(); }
    } finally { await cleanupUser(id); }
  });

  it('B [official]: multi-tenant isolation — different users both acquire', async () => {
    const id1 = await createUser();
    const id2 = await createUser();
    try {
      const c1 = await pool.connect();
      const c2 = await pool.connect();
      try {
        const [a, b] = await Promise.all([
          acquireFreeSearchHold(c1, id1),
          acquireFreeSearchHold(c2, id2),
        ]);
        assert.equal(a.allowed, true);
        assert.equal(b.allowed, true);
      } finally { c1.release(); c2.release(); }
    } finally {
      await cleanupUser(id1);
      await cleanupUser(id2);
    }
  });

  it('F [official]: expired lease reclaimable; old token cannot consume', async () => {
    const id = await createUser();
    try {
      const client = await pool.connect();
      try {
        const first = await acquireFreeSearchHold(client, id);
        await client.query(
          `UPDATE users SET free_search_hold_until = NOW() - interval '1 minute' WHERE id=$1`, [id]
        );
        const second = await acquireFreeSearchHold(client, id);
        assert.equal(second.allowed, true);
        assert.notEqual(second.holdToken, first.holdToken);
        assert.equal(await consumeFreeSearchHold(client, id, first.holdToken), false);
        const { rows } = await client.query(
          'SELECT free_search_used, free_search_hold_token FROM users WHERE id=$1', [id]
        );
        assert.equal(rows[0].free_search_used, false);
        assert.equal(rows[0].free_search_hold_token, second.holdToken);
      } finally { client.release(); }
    } finally { await cleanupUser(id); }
  });

  it('G [official]: replaced token — old token cannot renew/consume/release', async () => {
    const id = await createUser();
    try {
      const client = await pool.connect();
      try {
        const first = await acquireFreeSearchHold(client, id);
        await client.query(
          `UPDATE users SET free_search_hold_until = NOW() - interval '1 minute' WHERE id=$1`, [id]
        );
        const second = await acquireFreeSearchHold(client, id);
        assert.notEqual(second.holdToken, first.holdToken);
        assert.equal((await renewFreeSearchHold(client, id, first.holdToken)).renewed, false);
        assert.equal(await consumeFreeSearchHold(client, id, first.holdToken), false);
        await releaseFreeSearchHold(client, id, first.holdToken);
        const { rows } = await client.query(
          'SELECT free_search_hold_token, free_search_used FROM users WHERE id=$1', [id]
        );
        assert.equal(rows[0].free_search_hold_token, second.holdToken);
        assert.equal(rows[0].free_search_used, false);
      } finally { client.release(); }
    } finally { await cleanupUser(id); }
  });

  it('extra: valid consume sets free_search_used', async () => {
    const id = await createUser();
    try {
      const client = await pool.connect();
      try {
        const hold = await acquireFreeSearchHold(client, id);
        assert.equal(await consumeFreeSearchHold(client, id, hold.holdToken), true);
        const { rows } = await client.query(
          'SELECT free_search_used, free_search_hold_token FROM users WHERE id=$1', [id]
        );
        assert.equal(rows[0].free_search_used, true);
        assert.equal(rows[0].free_search_hold_token, null);
      } finally { client.release(); }
    } finally { await cleanupUser(id); }
  });

  it('extra: release restores availability', async () => {
    const id = await createUser();
    try {
      const client = await pool.connect();
      try {
        const hold = await acquireFreeSearchHold(client, id);
        await releaseFreeSearchHold(client, id, hold.holdToken);
        assert.equal((await acquireFreeSearchHold(client, id)).allowed, true);
      } finally { client.release(); }
    } finally { await cleanupUser(id); }
  });

  it('extra: other user cannot consume foreign token', async () => {
    const a = await createUser();
    const b = await createUser();
    try {
      const client = await pool.connect();
      try {
        const hold = await acquireFreeSearchHold(client, a);
        assert.equal(await consumeFreeSearchHold(client, b, hold.holdToken), false);
        const { rows } = await client.query(
          'SELECT free_search_used, free_search_hold_token FROM users WHERE id=$1', [a]
        );
        assert.equal(rows[0].free_search_used, false);
        assert.equal(rows[0].free_search_hold_token, hold.holdToken);
      } finally { client.release(); }
    } finally {
      await cleanupUser(a);
      await cleanupUser(b);
    }
  });

  it('extra: renew extends valid hold; wrong token fails', async () => {
    const id = await createUser();
    try {
      const client = await pool.connect();
      try {
        const hold = await acquireFreeSearchHold(client, id);
        assert.equal((await renewFreeSearchHold(client, id, hold.holdToken)).renewed, true);
        assert.equal(
          (await renewFreeSearchHold(client, id, '00000000-0000-0000-0000-000000000000')).renewed,
          false
        );
      } finally { client.release(); }
    } finally { await cleanupUser(id); }
  });

  it('extra: recovery does not clear a newer replaced token', async () => {
    const id = await createUser();
    try {
      const client = await pool.connect();
      let oldSearchId;
      let newToken;
      try {
        const first = await acquireFreeSearchHold(client, id);
        const ins = await client.query(
          `INSERT INTO searches (user_id, query, location, filters, status, providers_used, started_at, expires_at)
           VALUES ($1, 'old', 'loc', $2::jsonb, 'running', '[]'::jsonb,
                   NOW() - interval '3 hours', NOW() + interval '30 days')
           RETURNING id`,
          [id, JSON.stringify({ holdToken: first.holdToken })]
        );
        oldSearchId = ins.rows[0].id;
        await client.query(
          `UPDATE users SET free_search_hold_until = NOW() - interval '1 minute' WHERE id=$1`, [id]
        );
        const second = await acquireFreeSearchHold(client, id);
        newToken = second.holdToken;
        await client.query(
          `UPDATE users SET free_search_hold_until = NOW() + interval '20 minutes',
             free_search_hold_search_id = NULL WHERE id=$1`, [id]
        );
      } finally { client.release(); }

      await recoverAbandonedSearches(pool, { graceMinutes: 30 });
      const { rows: s } = await pool.query('SELECT status FROM searches WHERE id=$1', [oldSearchId]);
      assert.equal(s[0].status, 'failed');
      const { rows: u } = await pool.query(
        'SELECT free_search_hold_token FROM users WHERE id=$1', [id]
      );
      assert.equal(u[0].free_search_hold_token, newToken);
    } finally { await cleanupUser(id); }
  });
});
