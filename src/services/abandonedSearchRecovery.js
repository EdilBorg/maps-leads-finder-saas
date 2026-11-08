/**
 * Periodic recovery of abandoned running searches.
 * If unlock fails, the connection is destroyed (not returned to the pool).
 * Enable: ENABLE_ABANDONED_SEARCH_RECOVERY=1
 */

const {
  recoverAbandonedSearches,
  FREE_SEARCH_HOLD_MINUTES,
} = require('./freeSearchHold');

function defaultGetPool() {
  return require('../db/pool').getPool();
}

const ADVISORY_KEY = 87003145;
const INTERVAL_MS =
  parseInt(process.env.ABANDONED_SEARCH_RECOVERY_INTERVAL_MS || '300000', 10) || 300000;

let timer = null;
let running = false;
let stopRequested = false;

function log(level, msg, extra) {
  const payload = extra ? ` ${JSON.stringify(extra)}` : '';
  const line = `[abandoned-recovery] ${msg}${payload}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

function safeRelease(client, destroy) {
  if (!client || typeof client.release !== 'function') return;
  try {
    if (destroy) client.release(true);
    else client.release();
  } catch (_) {
    try { client.release(true); } catch (_) {}
  }
}

async function runOnce(deps = {}) {
  // Manual runOnce always executes; stopRequested only gates the scheduler tick().
  const getPoolFn = deps.getPool || defaultGetPool;
  const recoverFn = deps.recoverAbandonedSearches || recoverAbandonedSearches;
  const startedAt = Date.now();
  log('info', 'start');
  const pool = getPoolFn();
  const client = await pool.connect();
  let lockHeld = false;
  let destroyClient = false;

  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_KEY]);
    if (!rows[0] || !rows[0].ok) {
      log('info', 'skip', { reason: 'lock_held', ms: Date.now() - startedAt });
      return { skipped: true, reason: 'lock_held' };
    }
    lockHeld = true;
    const result = await recoverFn(client, { graceMinutes: FREE_SEARCH_HOLD_MINUTES + 5 });
    log('info', 'done', {
      abandoned: result.abandoned,
      holdsReleased: result.holdsReleased,
      ms: Date.now() - startedAt,
    });
    return { skipped: false, ...result };
  } catch (err) {
    log('error', 'failed', {
      message: err && err.message ? err.message : String(err),
      ms: Date.now() - startedAt,
    });
    throw err;
  } finally {
    if (lockHeld) {
      try {
        const unlock = await client.query('SELECT pg_advisory_unlock($1) AS ok', [ADVISORY_KEY]);
        const ok = unlock.rows && unlock.rows[0] && unlock.rows[0].ok === true;
        if (!ok) {
          log('error', 'unlock_returned_false', { key: ADVISORY_KEY });
          destroyClient = true;
        }
      } catch (unlockErr) {
        log('error', 'unlock_failed', {
          message: unlockErr && unlockErr.message ? unlockErr.message : String(unlockErr),
        });
        destroyClient = true;
      }
    }
    safeRelease(client, destroyClient);
  }
}

async function tick() {
  if (stopRequested) return;
  if (running) {
    log('info', 'skip', { reason: 'already_running_in_process' });
    return;
  }
  running = true;
  try {
    await runOnce();
  } catch (_) {
  } finally {
    running = false;
  }
}

function startAbandonedSearchRecovery() {
  if (process.env.ENABLE_ABANDONED_SEARCH_RECOVERY !== '1') {
    return { started: false, reason: 'disabled' };
  }
  if (timer) return { started: true, reason: 'already_running' };
  stopRequested = false;
  timer = setInterval(() => { tick(); }, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const t = setTimeout(() => { tick(); }, 15000);
  if (typeof t.unref === 'function') t.unref();
  log('info', 'scheduler_started', { intervalMs: INTERVAL_MS });
  return { started: true, intervalMs: INTERVAL_MS };
}

function stopAbandonedSearchRecovery() {
  stopRequested = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  log('info', 'scheduler_stopped');
}

async function waitForIdle(timeoutMs = 8000) {
  const start = Date.now();
  while (running && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return !running;
}

function isRunning() {
  return running;
}

module.exports = {
  runOnce,
  startAbandonedSearchRecovery,
  stopAbandonedSearchRecovery,
  waitForIdle,
  isRunning,
  ADVISORY_KEY,
  INTERVAL_MS,
};
