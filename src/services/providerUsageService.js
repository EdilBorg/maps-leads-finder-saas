/**
 * Atomic provider usage ledger: reserve → commit/release.
 * Never holds a transaction open across external HTTP calls.
 * Pricing snapshot: reserve stores unit/fixed costs; commit uses exactly those values.
 */
const crypto = require('crypto');

function getPool() {
  return require('../db/pool').getPool();
}

function toBigIntSafe(v) {
  if (v == null) return 0n;
  if (typeof v === 'bigint') return v;
  return BigInt(String(v));
}

function bigToNumber(v) {
  // For JSON responses only; internal math uses BigInt
  const b = toBigIntSafe(v);
  if (b > BigInt(Number.MAX_SAFE_INTEGER)) return b.toString();
  return Number(b);
}

async function getActivePricing(providerCode, client) {
  const db = client || getPool();
  const { rows } = await db.query(
    `SELECT * FROM provider_pricing
     WHERE provider_code = $1 AND active = TRUE
       AND effective_from <= NOW()
       AND (effective_until IS NULL OR effective_until > NOW())
     ORDER BY effective_from DESC LIMIT 1`,
    [providerCode]
  );
  if (!rows[0]) {
    return { pricingVersion: 'unset', unitCostMicroUsd: 0n, fixedExecutionCostMicroUsd: 0n };
  }
  return {
    pricingVersion: rows[0].pricing_version,
    unitCostMicroUsd: toBigIntSafe(rows[0].unit_cost_micro_usd),
    fixedExecutionCostMicroUsd: toBigIntSafe(rows[0].fixed_execution_cost_micro_usd),
  };
}

async function ensureUsageRow(client, userId, providerCode, periodStart, periodEnd) {
  const { rows } = await client.query(
    `INSERT INTO provider_usage (user_id, provider_code, period_start, period_end)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, provider_code, period_start) DO UPDATE SET updated_at = provider_usage.updated_at
     RETURNING *`,
    [userId, providerCode, periodStart, periodEnd]
  );
  return rows[0];
}

async function reserve({
  userId, providerCode, periodStart, periodEnd,
  results, apiCalls = 0, includeFixedCost = false,
  searchId = null, idempotencyKey = null, limits = {}, client: externalClient,
}) {
  const ownClient = !externalClient;
  const client = externalClient || (await getPool().connect());
  const key = idempotencyKey || `reserve:${userId}:${providerCode}:${searchId || crypto.randomUUID()}`;

  try {
    if (ownClient) await client.query('BEGIN');

    const existing = await client.query(
      `SELECT * FROM provider_usage_events WHERE idempotency_key = $1`, [key]
    );
    if (existing.rows[0]) {
      if (ownClient) await client.query('COMMIT');
      const meta = existing.rows[0].metadata || {};
      return {
        ok: true,
        replayed: true,
        event: existing.rows[0],
        reservedResults: existing.rows[0].results_delta,
        reservedCostMicroUsd: String(existing.rows[0].cost_micro_usd_delta),
        reservedApiCalls: existing.rows[0].api_calls_delta,
        pricingVersion: existing.rows[0].pricing_version,
        unitCostMicroUsd: meta.unitCostMicroUsd != null ? String(meta.unitCostMicroUsd) : '0',
        fixedExecutionCostMicroUsd: meta.fixedExecutionCostMicroUsd != null ? String(meta.fixedExecutionCostMicroUsd) : '0',
        includeFixedCost: !!meta.includeFixedCost,
        idempotencyKey: key,
        eventId: existing.rows[0].id,
      };
    }

    await ensureUsageRow(client, userId, providerCode, periodStart, periodEnd);
    await client.query(
      `SELECT id FROM provider_usage WHERE user_id=$1 AND provider_code=$2 AND period_start=$3 FOR UPDATE`,
      [userId, providerCode, periodStart]
    );

    const pricing = await getActivePricing(providerCode, client);
    const cost = BigInt(results) * pricing.unitCostMicroUsd
      + (includeFixedCost ? pricing.fixedExecutionCostMicroUsd : 0n);

    const { rows: usageRows } = await client.query(
      `SELECT * FROM provider_usage WHERE user_id=$1 AND provider_code=$2 AND period_start=$3`,
      [userId, providerCode, periodStart]
    );
    const u = usageRows[0];
    const resultsCommitted = u.results_used + u.results_reserved;
    const costCommitted = toBigIntSafe(u.cost_micro_usd_used) + toBigIntSafe(u.cost_micro_usd_reserved);
    const callsCommitted = u.api_calls_used + u.api_calls_reserved;

    if (limits.maxResults != null && resultsCommitted + results > limits.maxResults) {
      if (ownClient) await client.query('ROLLBACK');
      return { ok: false, reason: 'RESULTS_LIMIT', remaining: Math.max(0, limits.maxResults - resultsCommitted) };
    }
    if (limits.maxCostMicroUsd != null && costCommitted + cost > BigInt(limits.maxCostMicroUsd)) {
      if (ownClient) await client.query('ROLLBACK');
      return { ok: false, reason: 'COST_LIMIT' };
    }
    if (limits.maxApiCalls != null && callsCommitted + apiCalls > limits.maxApiCalls) {
      if (ownClient) await client.query('ROLLBACK');
      return { ok: false, reason: 'API_CALLS_LIMIT', remainingCalls: Math.max(0, limits.maxApiCalls - callsCommitted) };
    }

    await client.query(
      `UPDATE provider_usage SET
         results_reserved = results_reserved + $4,
         cost_micro_usd_reserved = cost_micro_usd_reserved + $5,
         api_calls_reserved = api_calls_reserved + $6,
         updated_at = NOW()
       WHERE user_id=$1 AND provider_code=$2 AND period_start=$3`,
      [userId, providerCode, periodStart, results, cost.toString(), apiCalls]
    );

    const pricingSnapshot = {
      periodStart,
      periodEnd,
      unitCostMicroUsd: pricing.unitCostMicroUsd.toString(),
      fixedExecutionCostMicroUsd: pricing.fixedExecutionCostMicroUsd.toString(),
      includeFixedCost: !!includeFixedCost,
    };

    const { rows: ev } = await client.query(
      `INSERT INTO provider_usage_events (
         user_id, search_id, provider_code, event_type,
         results_delta, api_calls_delta, cost_micro_usd_delta,
         idempotency_key, pricing_version, metadata
       ) VALUES ($1,$2,$3,'reserve',$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
      [userId, searchId, providerCode, results, apiCalls, cost.toString(), key, pricing.pricingVersion,
        JSON.stringify(pricingSnapshot)]
    );

    if (ownClient) await client.query('COMMIT');
    return {
      ok: true,
      reservedResults: results,
      reservedCostMicroUsd: cost.toString(),
      reservedApiCalls: apiCalls,
      pricingVersion: pricing.pricingVersion,
      unitCostMicroUsd: pricing.unitCostMicroUsd.toString(),
      fixedExecutionCostMicroUsd: pricing.fixedExecutionCostMicroUsd.toString(),
      includeFixedCost: !!includeFixedCost,
      idempotencyKey: key,
      eventId: ev[0].id,
    };
  } catch (err) {
    if (ownClient) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw err;
  } finally {
    if (ownClient) client.release();
  }
}

async function commit({
  userId, providerCode, periodStart,
  reservedResults, reservedCostMicroUsd, reservedApiCalls = 0,
  actualResults, actualApiCalls = 0, includeFixedCost = false,
  searchId = null, idempotencyKey = null, client: externalClient,
  pendingRemote = false,
  // Immutable pricing snapshot from the reserve event — must be used when present
  unitCostMicroUsd = null,
  fixedExecutionCostMicroUsd = null,
}) {
  const ownClient = !externalClient;
  const client = externalClient || (await getPool().connect());
  const key = idempotencyKey || `commit:${userId}:${providerCode}:${searchId || crypto.randomUUID()}`;

  try {
    if (ownClient) await client.query('BEGIN');
    const existing = await client.query(`SELECT * FROM provider_usage_events WHERE idempotency_key = $1`, [key]);
    if (existing.rows[0]) {
      if (ownClient) await client.query('COMMIT');
      return { ok: true, replayed: true };
    }

    await client.query(
      `SELECT id FROM provider_usage WHERE user_id=$1 AND provider_code=$2 AND period_start=$3 FOR UPDATE`,
      [userId, providerCode, periodStart]
    );

    // Prefer immutable snapshot from reserve; fall back to current pricing only if snapshot missing (legacy)
    let unitCost;
    let fixedCost;
    let pricingVersion;
    if (unitCostMicroUsd != null) {
      unitCost = toBigIntSafe(unitCostMicroUsd);
      fixedCost = toBigIntSafe(fixedExecutionCostMicroUsd || 0);
      pricingVersion = null; // will be filled from event if needed
    } else {
      const pricing = await getActivePricing(providerCode, client);
      unitCost = pricing.unitCostMicroUsd;
      fixedCost = pricing.fixedExecutionCostMicroUsd;
      pricingVersion = pricing.pricingVersion;
    }

    const actualCost = BigInt(actualResults) * unitCost
      + (includeFixedCost ? fixedCost : 0n);
    const reservedCost = toBigIntSafe(reservedCostMicroUsd);

    const excessResults = Math.max(0, actualResults - reservedResults);
    const excessCost = actualCost > reservedCost ? actualCost - reservedCost : 0n;

    // Clear full reservation, then add actual used (may exceed original reservation)
    await client.query(
      `UPDATE provider_usage SET
         results_reserved = GREATEST(0, results_reserved - $4),
         cost_micro_usd_reserved = GREATEST(0, cost_micro_usd_reserved - $5),
         api_calls_reserved = GREATEST(0, api_calls_reserved - $6),
         results_used = results_used + $7,
         cost_micro_usd_used = cost_micro_usd_used + $8,
         api_calls_used = api_calls_used + $9,
         updated_at = NOW()
       WHERE user_id=$1 AND provider_code=$2 AND period_start=$3`,
      [
        userId, providerCode, periodStart,
        reservedResults, reservedCost.toString(), reservedApiCalls,
        actualResults, actualCost.toString(), actualApiCalls,
      ]
    );

    const eventType = excessResults > 0 || excessCost > 0n ? 'excess' : 'commit';
    await client.query(
      `INSERT INTO provider_usage_events (
         user_id, search_id, provider_code, event_type,
         results_delta, api_calls_delta, cost_micro_usd_delta,
         excess_results, excess_cost_micro_usd,
         idempotency_key, pricing_version, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        userId, searchId, providerCode, eventType,
        actualResults, actualApiCalls, actualCost.toString(),
        excessResults, excessCost.toString(),
        key, pricingVersion,
        JSON.stringify({
          reservedResults,
          reservedCostMicroUsd: reservedCost.toString(),
          pendingRemote: !!pendingRemote,
          unitCostMicroUsd: unitCost.toString(),
          fixedExecutionCostMicroUsd: fixedCost.toString(),
          includeFixedCost: !!includeFixedCost,
        }),
      ]
    );

    if (ownClient) await client.query('COMMIT');
    return {
      ok: true,
      usedResults: actualResults,
      usedCostMicroUsd: actualCost.toString(),
      usedApiCalls: actualApiCalls,
      excessResults,
      excessCostMicroUsd: excessCost.toString(),
      pricingVersion,
    };
  } catch (err) {
    if (ownClient) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw err;
  } finally {
    if (ownClient) client.release();
  }
}

async function release({
  userId, providerCode, periodStart,
  reservedResults, reservedCostMicroUsd, reservedApiCalls = 0,
  searchId = null, idempotencyKey = null, client: externalClient,
  reason = 'release',
}) {
  const ownClient = !externalClient;
  const client = externalClient || (await getPool().connect());
  const key = idempotencyKey || `release:${userId}:${providerCode}:${searchId || crypto.randomUUID()}`;

  try {
    if (ownClient) await client.query('BEGIN');
    const existing = await client.query(`SELECT id FROM provider_usage_events WHERE idempotency_key = $1`, [key]);
    if (existing.rows[0]) {
      if (ownClient) await client.query('COMMIT');
      return { ok: true, replayed: true };
    }

    await client.query(
      `UPDATE provider_usage SET
         results_reserved = GREATEST(0, results_reserved - $4),
         cost_micro_usd_reserved = GREATEST(0, cost_micro_usd_reserved - $5),
         api_calls_reserved = GREATEST(0, api_calls_reserved - $6),
         updated_at = NOW()
       WHERE user_id=$1 AND provider_code=$2 AND period_start=$3`,
      [userId, providerCode, periodStart, reservedResults, String(reservedCostMicroUsd || 0), reservedApiCalls]
    );

    await client.query(
      `INSERT INTO provider_usage_events (
         user_id, search_id, provider_code, event_type,
         results_delta, api_calls_delta, cost_micro_usd_delta,
         idempotency_key, metadata
       ) VALUES ($1,$2,$3,'release',$4,$5,$6,$7,$8::jsonb)`,
      [userId, searchId, providerCode, -reservedResults, -reservedApiCalls, String(-(Number(reservedCostMicroUsd) || 0)), key, JSON.stringify({ reason })]
    );

    if (ownClient) await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    if (ownClient) { try { await client.query('ROLLBACK'); } catch (_) {} }
    throw err;
  } finally {
    if (ownClient) client.release();
  }
}

/**
 * Fail-closed: any DB / parse failure means the quota is treated as exhausted
 * (maxCallsPerPeriod = 0) rather than unlimited. Only an explicit null in
 * system_settings means unlimited.
 */
async function getTomTomGlobalConfig() {
  try {
    const { rows } = await getPool().query(`SELECT value FROM system_settings WHERE key = 'tomtom_global_quota'`);
    if (!rows[0] || rows[0].value == null) {
      // No row → treat as unlimited only when explicitly configured that way elsewhere;
      // default seed has null, which is intentional unlimited until admin sets a value.
      return { maxCallsPerPeriod: null, periodDays: 30 };
    }
    const v = rows[0].value;
    const maxRaw = v.max_calls_per_period;
    let max = null;
    if (maxRaw != null && maxRaw !== '') {
      const n = Number(maxRaw);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        // Invalid value → fail closed (zero allowance)
        return { maxCallsPerPeriod: 0, periodDays: 30, invalidConfig: true };
      }
      max = n > 0 ? n : null; // 0 or negative treated as unlimited? No: 0 = zero allowance
      if (n === 0) max = 0;
    }
    const periodDaysRaw = v.period_days != null ? Number(v.period_days) : 30;
    const periodDays = Number.isFinite(periodDaysRaw) && periodDaysRaw > 0 && periodDaysRaw <= 366
      ? Math.floor(periodDaysRaw) : 30;
    return {
      maxCallsPerPeriod: max,
      periodDays,
    };
  } catch (err) {
    // DB unavailable / query error → fail closed (deny further calls)
    return { maxCallsPerPeriod: 0, periodDays: 30, configError: true, errorMessage: err.message };
  }
}

function globalPeriodWindow(periodDays, now = new Date()) {
  const dayMs = periodDays * 24 * 60 * 60 * 1000;
  const startMs = Math.floor(now.getTime() / dayMs) * dayMs;
  return {
    periodStart: new Date(startMs).toISOString(),
    periodEnd: new Date(startMs + dayMs).toISOString(),
  };
}

async function reserveGlobalTomTomCalls(calls, { searchId = null, userId = null, idempotencyKey = null } = {}) {
  if (!Number.isFinite(calls) || calls < 0 || !Number.isInteger(calls)) {
    const err = new Error('calls must be a non-negative integer');
    err.code = 'VALIDATION';
    throw err;
  }
  const cfg = await getTomTomGlobalConfig();
  if (cfg.maxCallsPerPeriod == null) {
    return { ok: true, unlimited: true, reservedCalls: calls };
  }
  if (cfg.maxCallsPerPeriod === 0) {
    return { ok: false, reason: 'GLOBAL_TOMTOM_LIMIT', remaining: 0, configError: !!cfg.configError || !!cfg.invalidConfig };
  }
  if (!idempotencyKey) {
    const err = new Error('idempotencyKey required for TomTom global reserve');
    err.code = 'VALIDATION';
    throw err;
  }
  const window = globalPeriodWindow(cfg.periodDays);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT * FROM provider_global_usage_events WHERE idempotency_key = $1`, [idempotencyKey]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return {
        ok: true,
        replayed: true,
        reservedCalls: existing.rows[0].calls_delta,
        periodStart: existing.rows[0].period_start,
        periodEnd: window.periodEnd,
        idempotencyKey,
      };
    }
    await client.query(
      `INSERT INTO provider_global_usage (provider_code, period_start, period_end)
       VALUES ('tomtom', $1, $2) ON CONFLICT (provider_code, period_start) DO NOTHING`,
      [window.periodStart, window.periodEnd]
    );
    const { rows } = await client.query(
      `SELECT * FROM provider_global_usage WHERE provider_code='tomtom' AND period_start=$1 FOR UPDATE`,
      [window.periodStart]
    );
    const row = rows[0];
    const committed = row.calls_used + row.calls_reserved;
    if (committed + calls > cfg.maxCallsPerPeriod) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'GLOBAL_TOMTOM_LIMIT', remaining: Math.max(0, cfg.maxCallsPerPeriod - committed) };
    }
    await client.query(
      `UPDATE provider_global_usage SET calls_reserved = calls_reserved + $2, updated_at = NOW()
       WHERE provider_code='tomtom' AND period_start=$1`,
      [window.periodStart, calls]
    );
    await client.query(
      `INSERT INTO provider_global_usage_events (
         provider_code, event_type, period_start, calls_delta, search_id, user_id, idempotency_key, metadata
       ) VALUES ('tomtom','reserve',$1,$2,$3,$4,$5,$6::jsonb)`,
      [window.periodStart, calls, searchId, userId, idempotencyKey, JSON.stringify({ periodEnd: window.periodEnd })]
    );
    await client.query('COMMIT');
    return { ok: true, reservedCalls: calls, periodStart: window.periodStart, periodEnd: window.periodEnd, idempotencyKey };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function commitGlobalTomTomCalls(periodStart, reservedCalls, actualCalls, { idempotencyKey = null, searchId = null, userId = null } = {}) {
  if (!periodStart) return { ok: true, skipped: true };
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id FROM provider_global_usage_events WHERE idempotency_key = $1`, [idempotencyKey]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { ok: true, replayed: true };
      }
    }
    await client.query(
      `UPDATE provider_global_usage SET
         calls_reserved = GREATEST(0, calls_reserved - $2),
         calls_used = calls_used + $3, updated_at = NOW()
       WHERE provider_code='tomtom' AND period_start=$1`,
      [periodStart, reservedCalls, actualCalls]
    );
    if (idempotencyKey) {
      await client.query(
        `INSERT INTO provider_global_usage_events (
           provider_code, event_type, period_start, calls_delta, search_id, user_id, idempotency_key
         ) VALUES ('tomtom',$1,$2,$3,$4,$5,$6)`,
        [actualCalls > 0 ? 'commit' : 'release', periodStart, actualCalls, searchId, userId, idempotencyKey]
      );
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function releaseGlobalTomTomCalls(periodStart, reservedCalls, opts = {}) {
  return commitGlobalTomTomCalls(periodStart, reservedCalls, 0, opts);
}

async function getUserUsageSummary(userId, periodStart) {
  const { rows } = await getPool().query(
    `SELECT * FROM provider_usage WHERE user_id=$1 AND period_start=$2 ORDER BY provider_code`,
    [userId, periodStart]
  );
  return rows.map((r) => ({
    providerCode: r.provider_code,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    resultsUsed: r.results_used,
    resultsReserved: r.results_reserved,
    costMicroUsdUsed: bigToNumber(r.cost_micro_usd_used),
    costMicroUsdReserved: bigToNumber(r.cost_micro_usd_reserved),
    apiCallsUsed: r.api_calls_used,
    apiCallsReserved: r.api_calls_reserved,
  }));
}

module.exports = {
  getActivePricing, reserve, commit, release,
  getTomTomGlobalConfig, reserveGlobalTomTomCalls, commitGlobalTomTomCalls, releaseGlobalTomTomCalls,
  getUserUsageSummary, globalPeriodWindow, toBigIntSafe, bigToNumber,
};
