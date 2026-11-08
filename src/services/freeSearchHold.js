/**
 * Atomic free-search hold helpers (SQL only; no pool dependency).
 *
 * GLOBAL LOCK ORDER (deadlock prevention):
 * Always lock/touch users BEFORE searches when both tables are involved
 * in the same transaction. Counterpart: searchService.runAndPersist locks
 * the user row FOR UPDATE before updating searches.
 *
 * recoverAbandonedSearches accepts either a pg.Pool or a pg.PoolClient:
 * - Pool  → acquires a client, owns BEGIN/COMMIT and release
 * - Client → uses the given connection; caller owns lifecycle
 */

const crypto = require('crypto');

const FREE_SEARCH_HOLD_MINUTES = parseInt(process.env.FREE_SEARCH_HOLD_MINUTES || '20', 10) || 20;
const FREE_SEARCH_RENEW_INTERVAL_MS =
  parseInt(process.env.FREE_SEARCH_RENEW_INTERVAL_MS || '300000', 10) || 300000;

/**
 * Resolve whether `db` is a PoolClient, Pool, or query object.
 * pg.PoolClient has BOTH connect() and release(); check release FIRST so we
 * never call connect() again on an already-connected client.
 */
function resolveDbClient(db) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('recoverAbandonedSearches requires a pg.Pool or pg.PoolClient');
  }
  if (typeof db.release === 'function') {
    return { client: db, shouldRelease: false, source: 'client' };
  }
  if (typeof db.connect === 'function') {
    return { client: null, shouldRelease: true, source: 'pool', pool: db };
  }
  return { client: db, shouldRelease: false, source: 'query-object' };
}

async function acquireFreeSearchHold(client, userId, searchId = null) {
  const holdToken = crypto.randomUUID();
  const { rows } = await client.query(
    `UPDATE users SET
       free_search_hold_token = $2,
       free_search_hold_until = NOW() + ($3 || ' minutes')::interval,
       free_search_hold_search_id = $4,
       updated_at = NOW()
     WHERE id = $1
       AND free_search_used = FALSE
       AND (
         free_search_hold_token IS NULL
         OR free_search_hold_until IS NULL
         OR free_search_hold_until < NOW()
       )
     RETURNING id, free_search_used, free_search_hold_token, free_search_hold_until`,
    [userId, holdToken, String(FREE_SEARCH_HOLD_MINUTES), searchId]
  );
  if (rows[0]) {
    return {
      allowed: true,
      holdToken: rows[0].free_search_hold_token,
      freeSearch: true,
      holdUntil: rows[0].free_search_hold_until,
    };
  }
  const check = await client.query(
    `SELECT free_search_used, free_search_hold_token, free_search_hold_until FROM users WHERE id = $1`,
    [userId]
  );
  if (!check.rows[0]) return { allowed: false, reason: 'USER_NOT_FOUND' };
  if (check.rows[0].free_search_used) return { allowed: false, reason: 'FREE_SEARCH_USED' };
  return { allowed: false, reason: 'FREE_SEARCH_IN_PROGRESS' };
}

async function bindHoldToSearch(client, userId, holdToken, searchId) {
  if (!holdToken || !searchId) return false;
  const { rowCount } = await client.query(
    `UPDATE users SET free_search_hold_search_id = $3, updated_at = NOW()
     WHERE id = $1 AND free_search_hold_token = $2 AND free_search_used = FALSE
       AND free_search_hold_until IS NOT NULL AND free_search_hold_until > NOW()`,
    [userId, holdToken, searchId]
  );
  return rowCount > 0;
}

async function renewFreeSearchHold(client, userId, holdToken) {
  if (!holdToken) return { renewed: false };
  const { rowCount, rows } = await client.query(
    `UPDATE users SET free_search_hold_until = NOW() + ($3 || ' minutes')::interval, updated_at = NOW()
     WHERE id = $1 AND free_search_hold_token = $2 AND free_search_used = FALSE
       AND free_search_hold_until IS NOT NULL AND free_search_hold_until > NOW()
     RETURNING free_search_hold_until`,
    [userId, holdToken, String(FREE_SEARCH_HOLD_MINUTES)]
  );
  return rowCount > 0 ? { renewed: true, holdUntil: rows[0].free_search_hold_until } : { renewed: false };
}

async function consumeFreeSearchHold(client, userId, holdToken) {
  if (!holdToken) return false;
  const { rowCount } = await client.query(
    `UPDATE users SET free_search_used = TRUE, free_search_hold_token = NULL,
       free_search_hold_until = NULL, free_search_hold_search_id = NULL, updated_at = NOW()
     WHERE id = $1 AND free_search_hold_token = $2 AND free_search_used = FALSE
       AND free_search_hold_until IS NOT NULL AND free_search_hold_until > NOW()`,
    [userId, holdToken]
  );
  return rowCount > 0;
}

async function releaseFreeSearchHold(client, userId, holdToken) {
  if (!holdToken) return false;
  const { rowCount } = await client.query(
    `UPDATE users SET free_search_hold_token = NULL, free_search_hold_until = NULL,
       free_search_hold_search_id = NULL, updated_at = NOW()
     WHERE id = $1 AND free_search_hold_token = $2 AND free_search_used = FALSE`,
    [userId, holdToken]
  );
  return rowCount > 0;
}

/** Lock user row first (global order: users → searches). */
async function lockUserForUpdate(client, userId) {
  const { rows } = await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  return rows.length > 0;
}

async function recoverAbandonedSearches(db, opts = {}) {
  const grace =
    opts.graceMinutes != null ? opts.graceMinutes : FREE_SEARCH_HOLD_MINUTES + 5;
  const resolved = resolveDbClient(db);
  let client = resolved.client;
  const shouldRelease = resolved.shouldRelease;
  if (!client && resolved.pool) client = await resolved.pool.connect();
  if (!client) throw new Error('recoverAbandonedSearches: failed to obtain a database client');

  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT u.id FROM users u
       WHERE u.free_search_hold_token IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM searches s
            WHERE s.user_id = u.id AND s.status = 'running' AND s.completed_at IS NULL
              AND s.started_at < NOW() - ($1 || ' minutes')::interval
          )
       ORDER BY u.id FOR UPDATE OF u`,
      [String(grace)]
    );
    const { rows: abandoned } = await client.query(
      `UPDATE searches AS s
       SET status = 'failed', completed_at = NOW(),
           error_summary = COALESCE(s.error_summary, 'abandoned')
       FROM users AS u
       WHERE s.user_id = u.id AND s.status = 'running' AND s.completed_at IS NULL
         AND s.started_at < NOW() - ($1 || ' minutes')::interval
         AND NOT (
           u.free_search_hold_search_id IS NOT DISTINCT FROM s.id
           AND u.free_search_hold_token IS NOT NULL
           AND u.free_search_hold_until IS NOT NULL
           AND u.free_search_hold_until > NOW()
           AND u.free_search_used = FALSE
         )
       RETURNING s.id, s.user_id, s.filters`,
      [String(grace)]
    );
    let holdsReleased = 0;
    for (const row of abandoned) {
      const token =
        row.filters && typeof row.filters === 'object' ? row.filters.holdToken : null;
      if (!token) continue;
      const { rowCount } = await client.query(
        `UPDATE users SET free_search_hold_token = NULL, free_search_hold_until = NULL,
           free_search_hold_search_id = NULL, updated_at = NOW()
         WHERE id = $1 AND free_search_hold_token = $2 AND free_search_used = FALSE
           AND (free_search_hold_search_id IS NULL OR free_search_hold_search_id = $3)
           AND (free_search_hold_until IS NULL OR free_search_hold_until <= NOW())`,
        [row.user_id, token, row.id]
      );
      holdsReleased += rowCount;
    }
    await client.query('COMMIT');
    return { abandoned: abandoned.length, holdsReleased };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    if (shouldRelease && client && typeof client.release === 'function') client.release();
  }
}

module.exports = {
  acquireFreeSearchHold,
  bindHoldToSearch,
  renewFreeSearchHold,
  consumeFreeSearchHold,
  releaseFreeSearchHold,
  lockUserForUpdate,
  recoverAbandonedSearches,
  resolveDbClient,
  FREE_SEARCH_HOLD_MINUTES,
  FREE_SEARCH_RENEW_INTERVAL_MS,
};
