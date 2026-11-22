/**
 * Reconciles pending Apify / Bright Data / DataForSEO remote executions with usage ledger.
 * Pattern mirrors abandonedSearchRecovery: start/stop/waitForIdle, short DB transactions.
 */
const crypto = require('crypto');
const providerUsageService = require('./providerUsageService');

const INTERVAL_MS = Number(process.env.PENDING_REMOTE_RECONCILE_INTERVAL_MS) || 30000;
const LEASE_MS = Number(process.env.PENDING_REMOTE_LEASE_MS) || 60000;
const MAX_ATTEMPTS = Number(process.env.PENDING_REMOTE_MAX_ATTEMPTS) || 40;
const BATCH = Number(process.env.PENDING_REMOTE_BATCH) || 5;
const ENABLED = process.env.PENDING_REMOTE_RECONCILE_ENABLED !== '0';

let timer = null;
let startupTimeout = null;
let stopRequested = false;
let running = false;
const workerId = `reconciler-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

function getPool() {
  return require('../db/pool').getPool();
}

function log(level, msg, extra) {
  const line = { component: 'pendingRemoteReconciler', level, msg, workerId, ...(extra || {}) };
  if (level === 'error') console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

function backoffMs(attempts) {
  const base = Math.min(3600000, 5000 * Math.pow(2, Math.min(attempts, 10)));
  return base + Math.floor(Math.random() * 1000);
}

async function acquireBatch() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id FROM pending_remote_executions
       WHERE status IN ('pending', 'reconciling')
         AND next_attempt_at <= NOW()
         AND attempts < $1
         AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
       ORDER BY next_attempt_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [MAX_ATTEMPTS, BATCH]
    );
    if (!rows.length) {
      await client.query('COMMIT');
      return [];
    }
    const ids = rows.map((r) => r.id);
    await client.query(
      `UPDATE pending_remote_executions SET
         status = 'reconciling',
         lease_owner = $2,
         lease_expires_at = NOW() + ($3 || ' milliseconds')::interval,
         updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [ids, workerId, String(LEASE_MS)]
    );
    const { rows: full } = await client.query(
      `SELECT * FROM pending_remote_executions WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    await client.query('COMMIT');
    return full;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function stillOwnsLease(id) {
  const { rows } = await getPool().query(
    `SELECT id FROM pending_remote_executions
     WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > NOW()
       AND status = 'reconciling'`,
    [id, workerId]
  );
  return rows.length > 0;
}

/**
 * Atomically extend lease if this worker still owns it.
 * Returns false if lease was lost (another worker or expiry).
 */
async function renewLease(id) {
  const { rows } = await getPool().query(
    `UPDATE pending_remote_executions SET
       lease_expires_at = NOW() + ($3 || ' milliseconds')::interval,
       updated_at = NOW()
     WHERE id = $1
       AND lease_owner = $2
       AND status = 'reconciling'
       AND lease_expires_at > NOW()
     RETURNING id`,
    [id, workerId, String(LEASE_MS)]
  );
  return rows.length > 0;
}

async function scheduleRetry(row, errorMessage) {
  const attempts = (row.attempts || 0) + 1;
  const delay = backoffMs(attempts);
  // At MAX_ATTEMPTS without confirmed remote outcome: intervention (not 'failed').
  // Reservation stays held; workers never reclaim intervention rows.
  const terminal = attempts >= MAX_ATTEMPTS;
  const status = terminal ? 'intervention' : 'pending';
  await getPool().query(
    `UPDATE pending_remote_executions SET
       status = $2,
       attempts = $3,
       next_attempt_at = CASE WHEN $2 = 'intervention' THEN NOW() + INTERVAL '100 years' ELSE NOW() + ($4 || ' milliseconds')::interval END,
       last_error = $5,
       lease_owner = NULL,
       lease_expires_at = NULL,
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'intervention', $2 = 'intervention',
         'intervention_reason', CASE WHEN $2 = 'intervention' THEN $5 ELSE NULL END,
         'last_schedule_at', NOW()::text
       ),
       updated_at = NOW()
     WHERE id = $1`,
    [
      row.id,
      status,
      attempts,
      String(delay),
      (errorMessage || '').slice(0, 500),
    ]
  );
  if (terminal) {
    log('error', 'pending_remote_intervention', {
      id: row.id,
      provider: row.provider_code,
      externalRunId: row.external_run_id,
      message: errorMessage,
    });
  }
}

async function resolveSuccess(row, actual) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const own = await client.query(
      `SELECT id FROM pending_remote_executions
       WHERE id = $1 AND lease_owner = $2 AND status = 'reconciling' FOR UPDATE`,
      [row.id, workerId]
    );
    if (!own.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'lease_lost' };
    }

    if (row.period_start && (row.reserved_results != null || row.reserved_cost_micro_usd != null)) {
      // Prefer the same idempotency key as the normal search path so a prior
      // commitProviderMetrics cannot be double-applied by the reconciler.
      const normalKey = row.search_id
        ? `commit:${row.user_id}:${row.search_id}:${row.provider_code}`
        : null;
      const idempotencyKey = normalKey || `reconcile-commit:${row.id}`;
      await providerUsageService.commit({
        userId: row.user_id,
        providerCode: row.provider_code,
        periodStart: row.period_start,
        reservedResults: row.reserved_results || 0,
        reservedCostMicroUsd: row.reserved_cost_micro_usd || 0,
        reservedApiCalls: row.reserved_api_calls || 0,
        actualResults: actual.results || 0,
        actualApiCalls: actual.apiCalls || 0,
        includeFixedCost: !!row.include_fixed_cost,
        searchId: row.search_id,
        idempotencyKey,
        client,
        unitCostMicroUsd: row.unit_cost_micro_usd,
        fixedExecutionCostMicroUsd: row.fixed_execution_cost_micro_usd,
        pricingVersion: row.pricing_version,
      });
    }

    await client.query(
      `UPDATE pending_remote_executions SET
         status = 'resolved',
         actual_results = $2,
         actual_cost_micro_usd = $3,
         actual_api_calls = $4,
         resolved_at = NOW(),
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [
        row.id,
        actual.results || 0,
        actual.costMicroUsd != null ? String(actual.costMicroUsd) : null,
        actual.apiCalls || 0,
      ]
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function fetchApifyStatus(runId) {
  const token = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;
  if (!token) throw Object.assign(new Error('APIFY_TOKEN missing'), { code: 'NOT_CONFIGURED' });
  const base = (process.env.APIFY_API_BASE || 'https://api.apify.com/v2').replace(/\/$/, '');
  const res = await fetch(base + '/actor-runs/' + encodeURIComponent(runId), {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw Object.assign(new Error('Apify status HTTP ' + res.status), { httpStatus: res.status });
  const json = await res.json();
  return json.data || json;
}

async function fetchApifyItems(runId) {
  const token = process.env.APIFY_TOKEN || process.env.APIFY_API_TOKEN;
  const base = (process.env.APIFY_API_BASE || 'https://api.apify.com/v2').replace(/\/$/, '');
  const res = await fetch(
    base + '/actor-runs/' + encodeURIComponent(runId) + '/dataset/items?clean=true&format=json',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!res.ok) throw Object.assign(new Error('Apify dataset HTTP ' + res.status), { httpStatus: res.status });
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

async function fetchBrightProgress(snapshotId) {
  const key = process.env.BRIGHTDATA_API_KEY;
  if (!key) throw Object.assign(new Error('BRIGHTDATA_API_KEY missing'), { code: 'NOT_CONFIGURED' });
  const res = await fetch(
    'https://api.brightdata.com/datasets/v3/progress/' + encodeURIComponent(snapshotId),
    { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } }
  );
  if (!res.ok) throw Object.assign(new Error('Bright progress HTTP ' + res.status), { httpStatus: res.status });
  return res.json();
}

async function fetchBrightSnapshot(snapshotId) {
  const key = process.env.BRIGHTDATA_API_KEY;
  const res = await fetch(
    'https://api.brightdata.com/datasets/v3/snapshot/' + encodeURIComponent(snapshotId) + '?format=json',
    { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } }
  );
  if (!res.ok) throw Object.assign(new Error('Bright snapshot HTTP ' + res.status), { httpStatus: res.status });
  const data = await res.json();
  return Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
}

async function processRow(row) {
  if (!(await stillOwnsLease(row.id))) return;

  const externalId = row.external_run_id;
  if (!externalId) {
    await scheduleRetry(row, 'missing external_run_id');
    return;
  }

  if (row.provider_code === 'dataforseo') {
    const dfs = require('./providers/dataForSeoProvider');
    // Single GET (no long poll) so work finishes well under LEASE_MS.
    // Renew lease before and after the remote call.
    if (!(await renewLease(row.id))) return;

    let got;
    try {
      got = await dfs.getTaskResult(row.external_run_id, null);
    } catch (err) {
      await scheduleRetry(row, (err && err.message) || 'dataforseo_fetch_error');
      return;
    }
    if (!(await stillOwnsLease(row.id))) return;

    if (got.status === 'pending') {
      await scheduleRetry(row, 'still_running:' + (got.statusCode || 'pending'));
      return;
    }

    if (got.status === 'ready') {
      const items = Array.isArray(got.items) ? got.items : [];
      const leads = [];
      for (let i = 0; i < items.length; i++) {
        const mapped = dfs.mapItem(items[i], i);
        if (mapped) leads.push(mapped);
      }
      if (!(await renewLease(row.id))) return;
      const unit = row.unit_cost_micro_usd != null ? BigInt(String(row.unit_cost_micro_usd)) : 0n;
      const fixed = row.include_fixed_cost && row.fixed_execution_cost_micro_usd != null
        ? BigInt(String(row.fixed_execution_cost_micro_usd)) : 0n;
      const cost = BigInt(leads.length) * unit + fixed;
      const apiCalls = Math.max(1, Number(row.reserved_api_calls) || 1);
      await resolveSuccess(row, {
        results: leads.length,
        apiCalls,
        costMicroUsd: cost.toString(),
      });
      return;
    }

    // Terminal remote error
    if (got.status === 'error') {
      const code = got.statusCode;
      // Unknown / ambiguous remote state → retry then intervention; do not release reserve
      await scheduleRetry(row, 'dataforseo_error:' + (got.message || code || 'error'));
      return;
    }

    await scheduleRetry(row, 'dataforseo_status:unknown');
    return;
  }
  if (row.provider_code === 'apify') {
    const data = await fetchApifyStatus(externalId);
    const status = String(data.status || '').toUpperCase();
    if (status === 'RUNNING' || status === 'READY' || status === 'PENDING') {
      await scheduleRetry(row, 'still_running:' + status);
      return;
    }
    if (status === 'SUCCEEDED') {
      const items = await fetchApifyItems(externalId);
      if (!(await stillOwnsLease(row.id))) return;
      const unit = row.unit_cost_micro_usd != null ? BigInt(String(row.unit_cost_micro_usd)) : 0n;
      const fixed = row.include_fixed_cost && row.fixed_execution_cost_micro_usd != null
        ? BigInt(String(row.fixed_execution_cost_micro_usd)) : 0n;
      const cost = BigInt(items.length) * unit + fixed;
      await resolveSuccess(row, {
        results: items.length,
        apiCalls: 1,
        costMicroUsd: cost.toString(),
      });
      return;
    }
    if (['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT'].includes(status)) {
      // Do not assume zero cost without evidence — keep protected via retry/fail
      await scheduleRetry(row, 'terminal_uncertain:' + status);
      return;
    }
    await scheduleRetry(row, 'unknown_status:' + status);
    return;
  }

  if (row.provider_code === 'brightdata') {
    const prog = await fetchBrightProgress(externalId);
    const status = String(prog.status || prog.snapshot_status || '').toLowerCase();
    if (['starting', 'running', 'building', 'collecting'].includes(status)) {
      await scheduleRetry(row, 'still_running:' + status);
      return;
    }
    if (status === 'ready') {
      const items = await fetchBrightSnapshot(externalId);
      if (!(await stillOwnsLease(row.id))) return;
      const unit = row.unit_cost_micro_usd != null ? BigInt(String(row.unit_cost_micro_usd)) : 0n;
      const cost = BigInt(items.length) * unit;
      await resolveSuccess(row, {
        results: items.length,
        apiCalls: 1,
        costMicroUsd: cost.toString(),
      });
      return;
    }
    if (['failed', 'canceled', 'cancelled', 'error'].includes(status)) {
      await scheduleRetry(row, 'terminal_uncertain:' + status);
      return;
    }
    await scheduleRetry(row, 'unknown_status:' + status);
    return;
  }

  await scheduleRetry(row, 'unsupported_provider');
}

async function tick() {
  if (stopRequested || running) return;
  running = true;
  try {
    const batch = await acquireBatch();
    for (const row of batch) {
      if (stopRequested) break;
      try {
        await processRow(row);
      } catch (err) {
        log('error', 'row_failed', { id: row.id, message: err && err.message });
        try {
          await scheduleRetry(row, err && err.message);
        } catch (_) {}
      }
    }
  } catch (err) {
    log('error', 'tick_failed', { message: err && err.message });
  } finally {
    running = false;
  }
}

function startPendingRemoteReconciler() {
  if (!ENABLED) return { started: false, reason: 'disabled' };
  if (timer) return { started: true, reason: 'already_running' };
  stopRequested = false;
  timer = setInterval(() => { tick(); }, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    tick();
  }, 2000);
  if (typeof startupTimeout.unref === 'function') startupTimeout.unref();
  log('info', 'scheduler_started', { intervalMs: INTERVAL_MS });
  return { started: true, intervalMs: INTERVAL_MS };
}

function stopPendingRemoteReconciler() {
  stopRequested = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
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

module.exports = {
  renewLease,
  stillOwnsLease,
  scheduleRetry,
  resolveSuccess,
  startPendingRemoteReconciler,
  stopPendingRemoteReconciler,
  waitForIdle,
  acquireBatch,
  processRow,
  workerId,
  MAX_ATTEMPTS,
  backoffMs,
};
