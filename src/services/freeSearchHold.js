/**
 * Atomic free-search hold helpers (SQL only; no pool dependency).
 * Permanent flag: users.free_search_used
 * Temporary hold: users.free_search_hold_token + free_search_hold_until
 */

const crypto = require('crypto');

const FREE_SEARCH_HOLD_MINUTES = parseInt(process.env.FREE_SEARCH_HOLD_MINUTES || '20', 10) || 20;

async function acquireFreeSearchHold(client, userId) {
  const holdToken = crypto.randomUUID();
  const { rows } = await client.query(
    `UPDATE users SET
       free_search_hold_token = $2,
       free_search_hold_until = NOW() + ($3 || ' minutes')::interval,
       updated_at = NOW()
     WHERE id = $1
       AND free_search_used = FALSE
       AND (
         free_search_hold_token IS NULL
         OR free_search_hold_until IS NULL
         OR free_search_hold_until < NOW()
       )
     RETURNING id, free_search_used, free_search_hold_token`,
    [userId, holdToken, String(FREE_SEARCH_HOLD_MINUTES)]
  );

  if (rows[0]) {
    return { allowed: true, holdToken: rows[0].free_search_hold_token, freeSearch: true };
  }

  const check = await client.query(
    `SELECT free_search_used, free_search_hold_token, free_search_hold_until
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!check.rows[0]) return { allowed: false, reason: 'USER_NOT_FOUND' };
  if (check.rows[0].free_search_used) return { allowed: false, reason: 'FREE_SEARCH_USED' };
  return { allowed: false, reason: 'FREE_SEARCH_IN_PROGRESS' };
}

async function consumeFreeSearchHold(client, userId, holdToken) {
  if (!holdToken) return false;
  const { rowCount } = await client.query(
    `UPDATE users SET
       free_search_used = TRUE,
       free_search_hold_token = NULL,
       free_search_hold_until = NULL,
       updated_at = NOW()
     WHERE id = $1
       AND free_search_hold_token = $2`,
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
       updated_at = NOW()
     WHERE id = $1
       AND free_search_hold_token = $2
       AND free_search_used = FALSE`,
    [userId, holdToken]
  );
  return rowCount > 0;
}

module.exports = {
  acquireFreeSearchHold,
  consumeFreeSearchHold,
  releaseFreeSearchHold,
  FREE_SEARCH_HOLD_MINUTES,
};
