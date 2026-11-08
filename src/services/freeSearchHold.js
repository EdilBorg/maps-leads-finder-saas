/**
 * Atomic free-search hold helpers.
 * Consume requires token + free_search_used=FALSE + hold_until > NOW() in SQL.
 */
const crypto = require('crypto');

const FREE_SEARCH_HOLD_MINUTES = parseInt(process.env.FREE_SEARCH_HOLD_MINUTES || '20', 10) || 20;
const FREE_SEARCH_RENEW_INTERVAL_MS =
  parseInt(process.env.FREE_SEARCH_RENEW_INTERVAL_MS || '300000', 10) || 300000;

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
    `UPDATE users SET
       free_search_used = TRUE,
       free_search_hold_token = NULL,
       free_search_hold_until = NULL,
       free_search_hold_search_id = NULL,
       updated_at = NOW()
     WHERE id = $1
       AND free_search_hold_token = $2
       AND free_search_used = FALSE
       AND free_search_hold_until IS NOT NULL
       AND free_search_hold_until > NOW()`,
    [userId, holdToken]
  );
  return rowCount > 0;
}

async function releaseFreeSearchHold(client, userId, holdToken) {
  if (!holdToken) return false;
  const { rowCount } = await client.query(
    `UPDATE users SET
       free_search_hold_token = NULL,
       free_search_hold_until = NULL,
       free_search_hold_search_id = NULL,
       updated_at = NOW()
     WHERE id = $1 AND free_search_hold_token = $2 AND free_search_used = FALSE`,
    [userId, holdToken]
  );
  return rowCount > 0;
}

async function recoverAbandonedSearches(db, opts = {}) {
  const grace = opts.graceMinutes != null ? opts.graceMinutes : FREE_SEARCH_HOLD_MINUTES + 5;
  const client = db.query && !db.release ? db : await db.connect();
  const shouldRelease = Boolean(db.release);
  try {
    await client.query('BEGIN');
    const { rows: abandoned } = await client.query(
      `UPDATE searches SET status = 'failed', completed_at = NOW(),
         error_summary = COALESCE(error_summary, 'abandoned')
       WHERE status = 'running' AND completed_at IS NULL
         AND started_at < NOW() - ($1 || ' minutes')::interval
       RETURNING id, user_id, filters`,
      [String(grace)]
    );
    let holdsReleased = 0;
    for (const row of abandoned) {
      const token = row.filters && typeof row.filters === 'object' ? row.filters.holdToken : null;
      if (!token) continue;
      const { rowCount } = await client.query(
        `UPDATE users SET free_search_hold_token = NULL, free_search_hold_until = NULL,
           free_search_hold_search_id = NULL, updated_at = NOW()
         WHERE id = $1 AND free_search_hold_token = $2 AND free_search_used = FALSE
           AND (free_search_hold_search_id IS NULL OR free_search_hold_search_id = $3)`,
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
    if (shouldRelease) client.release();
  }
}

module.exports = {
  acquireFreeSearchHold,
  bindHoldToSearch,
  renewFreeSearchHold,
  consumeFreeSearchHold,
  releaseFreeSearchHold,
  recoverAbandonedSearches,
  FREE_SEARCH_HOLD_MINUTES,
  FREE_SEARCH_RENEW_INTERVAL_MS,
};
