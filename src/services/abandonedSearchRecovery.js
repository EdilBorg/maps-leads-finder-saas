/**
 * Periodic recovery of abandoned running searches.
 * pg_try_advisory_lock so multiple Render instances do not race.
 * Enable: ENABLE_ABANDONED_SEARCH_RECOVERY=1
 */
const { getPool } = require('../db/pool');
const {
  recoverAbandonedSearches,
  FREE_SEARCH_HOLD_MINUTES,
} = require('./freeSearchHold');

const ADVISORY_KEY = 87003145;
const INTERVAL_MS =
  parseInt(process.env.ABANDONED_SEARCH_RECOVERY_INTERVAL_MS || '300000', 10) || 300000;

let timer = null;

async function runOnce() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_KEY]);
    if (!rows[0] || !rows[0].ok) return { skipped: true, reason: 'lock_held' };
    try {
      const result = await recoverAbandonedSearches(client, {
        graceMinutes: FREE_SEARCH_HOLD_MINUTES + 5,
      });
      return { skipped: false, ...result };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

function startAbandonedSearchRecovery() {
  if (process.env.ENABLE_ABANDONED_SEARCH_RECOVERY !== '1') {
    return { started: false, reason: 'disabled' };
  }
  if (timer) return { started: true, reason: 'already_running' };
  const tick = () => { runOnce().catch(() => {}); };
  timer = setInterval(tick, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const t = setTimeout(tick, 15000);
  if (typeof t.unref === 'function') t.unref();
  return { started: true, intervalMs: INTERVAL_MS };
}

function stopAbandonedSearchRecovery() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  runOnce,
  startAbandonedSearchRecovery,
  stopAbandonedSearchRecovery,
  ADVISORY_KEY,
  INTERVAL_MS,
};
