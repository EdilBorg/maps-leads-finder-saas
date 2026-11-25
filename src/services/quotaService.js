/**
 * Authorisation gate: trial vs paid quotas per provider.
 * Policy: if trial still available, prefer trial (does not consume paid quotas).
 * Paid path only when free_search_used or hold blocked for non-in-progress reasons.
 * Global TomTom quota is always enforced, including trial.
 *
 * pendingRemote: when a remote provider may still bill after local cancel/fail,
 * reservations are NOT released. A pending_remote_executions row is created for
 * later reconciliation. Never commit(actual=0) while pendingRemote — that would
 * free the financial reserve incorrectly.
 */
const planService = require('./planService');
const subscriptionService = require('./subscriptionService');
const leadQuotaService = require('./leadQuotaService');
const providerUsageService = require('./providerUsageService');
const { acquireFreeSearchHold } = require('./freeSearchHold');
const { PROVIDER_MAX } = require('./searchEngine');

const TRIAL_MAX_LEADS = 200;
const DEFAULT_PAID_LIMITS = Object.freeze({
  dataforseo: { maxResults: null, maxCostMicroUsd: null, maxApiCalls: null },
  tomtom: { maxResults: null, maxCostMicroUsd: null, maxApiCalls: null },
  // historical
  apify: { maxResults: 1000, maxCostMicroUsd: null },
  brightdata: { maxResults: 1500, maxCostMicroUsd: null },
});

function getPool() {
  return require('../db/pool').getPool();
}

/**
 * Reserve global TomTom calls when the provider list includes tomtom or when
 * Bright Data may perform geocoding (1 call). Used by both trial and paid paths.
 */
async function reserveTrialGlobalTomTom(userId, searchId, providerCodes) {
  // Discover only: at most 1 call per search. Geocoding does not consume Discover quota.
  const needsTomTom = providerCodes.includes('tomtom');
  let estCalls = needsTomTom ? 1 : 0;
  if (estCalls === 0) return null;

  const globalReserve = await providerUsageService.reserveGlobalTomTomCalls(estCalls, {
    searchId,
    userId,
    idempotencyKey: `greserve-trial:${userId}:${searchId || 'none'}:tomtom`,
  });
  if (!globalReserve.ok) {
    return { denied: true, reason: 'GLOBAL_TOMTOM_LIMIT', remaining: globalReserve.remaining };
  }
  if (globalReserve.unlimited) return { unlimited: true };
  return globalReserve;
}

/**
 * @param {object} client - pg client inside open transaction
 */
async function authorizeAndReserve(client, {
  userId,
  searchId = null,
  requestedLimit = 100,
  providerCodes = ['dataforseo', 'tomtom'],
}) {
  const hold = await acquireFreeSearchHold(client, userId, searchId);
  if (hold.allowed) {
    const global = await reserveTrialGlobalTomTom(userId, searchId, providerCodes);
    if (global && global.denied) {
      return {
        mode: 'denied',
        reason: 'GLOBAL_TOMTOM_LIMIT',
        message: 'Quota global TomTom esgotada. Tente mais tarde.',
        holdToken: null,
        providers: [],
      };
    }
    return {
      mode: 'trial',
      holdToken: hold.holdToken,
      holdUntil: hold.holdUntil,
      limit: Math.min(requestedLimit, TRIAL_MAX_LEADS),
      providers: providerCodes.map((code) => ({
        code,
        allowed: true,
        reason: null,
        reserve: null,
      })),
      globalTomTom: global && !global.unlimited ? global : null,
    };
  }

  if (hold.reason === 'FREE_SEARCH_IN_PROGRESS') {
    return {
      mode: 'denied',
      reason: 'FREE_SEARCH_IN_PROGRESS',
      message: 'Já existe uma pesquisa gratuita em curso. Aguarde ou tente mais tarde.',
      holdToken: null,
      providers: [],
    };
  }

  if (!searchId) {
    return {
      mode: 'denied',
      reason: 'MISSING_SEARCH_ID',
      message: 'Identificador de pesquisa em falta para reserva de quotas.',
      holdToken: null,
      providers: [],
    };
  }

  const sub = await subscriptionService.getActiveSubscription(userId, client);
  if (!sub) {
    return {
      mode: 'denied',
      reason: 'NO_QUOTA',
      message: 'Quota gratuita indisponível. É necessária uma subscrição activa.',
      holdToken: null,
      providers: [],
    };
  }

  const window = subscriptionService.resolvePeriodWindow(sub, new Date());
  if (!window) {
    return {
      mode: 'denied',
      reason: 'SUBSCRIPTION_EXPIRED',
      message: 'A sua subscrição expirou.',
      holdToken: null,
      providers: [],
    };
  }

  // Commercial delivered-leads quota (plan.max_results_per_month)
  const planRow = await planService.getPlanById(sub.planId, client);
  const planLeadLimit = planRow && planRow.maxResultsPerMonth != null
    ? Number(planRow.maxResultsPerMonth)
    : null;

  let leadHold = null;
  if (planLeadLimit != null && planLeadLimit > 0) {
    leadHold = await leadQuotaService.reserveLeadQuota(client, {
      userId,
      searchId,
      requestedLimit,
      planLimit: planLeadLimit,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      idempotencyKey: `lead-quota:${userId}:${searchId}`,
    });
    if (!leadHold.ok) {
      return {
        mode: 'denied',
        reason: leadHold.reason || 'QUOTA_EXHAUSTED',
        message: leadHold.message || 'Quota de leads esgotada neste ciclo.',
        holdToken: null,
        providers: [],
        leadHold,
      };
    }
  }

  const planLimits = await planService.listProviderLimits(sub.planId, client);
  const limitByCode = {};
  for (const pl of planLimits) limitByCode[pl.providerCode] = pl;

  const allowed = [];
  const skipped = [];

  for (const code of providerCodes) {
    const pl = limitByCode[code] || {};
    const defaults = DEFAULT_PAID_LIMITS[code] || {};
    const maxResults = pl.maxResultsPerPeriod != null ? pl.maxResultsPerPeriod
      : (defaults.maxResults != null ? defaults.maxResults : null);
    const maxCost = pl.maxCostMicroUsdPerPeriod != null ? pl.maxCostMicroUsdPerPeriod
      : (defaults.maxCostMicroUsd != null ? defaults.maxCostMicroUsd : null);
    const maxApiCalls = pl.maxApiCallsPerPeriod != null ? pl.maxApiCallsPerPeriod
      : (defaults.maxApiCalls != null ? defaults.maxApiCalls : null);

    const wantResults = Math.min(
      PROVIDER_MAX[code] || 200,
      requestedLimit || 200,
      maxResults != null ? maxResults : (PROVIDER_MAX[code] || 200)
    );

    let globalReserve = null;
    let geoBlocked = false;

    if (code === 'tomtom') {
      const estCalls = 1;
      globalReserve = await providerUsageService.reserveGlobalTomTomCalls(estCalls, {
        searchId,
        userId,
        idempotencyKey: `greserve:${userId}:${searchId}:tomtom`,
      });
      if (!globalReserve.ok) {
        skipped.push({ code, allowed: false, reason: 'GLOBAL_TOMTOM_LIMIT', reserve: null });
        continue;
      }
    }

    // Bright Data is not an active search provider. Do not reserve Discover quota for geocoding.
    // Historical BD path: geoBlocked stays false; geocode must not touch Discover ledger.

    const reserveResult = await providerUsageService.reserve({
      userId,
      providerCode: code,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      results: wantResults,
      apiCalls: code === 'tomtom' ? 1 : 1,
      includeFixedCost: code === 'apify',
      searchId,
      idempotencyKey: `reserve:${userId}:${searchId}:${code}`,
      limits: { maxResults, maxCostMicroUsd: maxCost, maxApiCalls },
      client,
    });

    if (!reserveResult.ok) {
      if (globalReserve && globalReserve.ok && !globalReserve.unlimited && globalReserve.periodStart) {
        await providerUsageService.releaseGlobalTomTomCalls(
          globalReserve.periodStart, globalReserve.reservedCalls, {
            idempotencyKey: `grelease:${userId}:${searchId}:tomtom`,
            searchId, userId,
          }
        );
      }
      if (globalReserve && globalReserve.geo && !globalReserve.geo.unlimited) {
        await providerUsageService.releaseGlobalTomTomCalls(
          globalReserve.geo.periodStart, globalReserve.geo.reservedCalls, {
            idempotencyKey: `grelease-geo:${userId}:${searchId}:bd`,
            searchId, userId,
          }
        );
      }
      skipped.push({ code, allowed: false, reason: reserveResult.reason, reserve: null });
      continue;
    }

    allowed.push({
      code,
      allowed: true,
      reason: null,
      geoBlocked: !!geoBlocked,
      reserve: {
        ...reserveResult,
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        global: globalReserve && (globalReserve.periodStart || globalReserve.geo)
          ? globalReserve
          : null,
        unitCostMicroUsd: reserveResult.unitCostMicroUsd,
        fixedExecutionCostMicroUsd: reserveResult.fixedExecutionCostMicroUsd,
        includeFixedCost: reserveResult.includeFixedCost,
        geoBlocked: !!geoBlocked,
      },
    });
  }

  if (allowed.length === 0) {
    if (leadHold && leadHold.ok && searchId) {
      try { await leadQuotaService.releaseLeadQuota(client, { userId, searchId }); } catch (_) {}
    }
    return {
      mode: 'denied',
      reason: 'PROVIDERS_EXHAUSTED',
      message: 'Todos os providers disponíveis esgotaram a quota deste ciclo.',
      holdToken: null,
      subscription: sub,
      period: window,
      providers: skipped,
    };
  }

  const planCap = sub.maxResultsPerSearch != null && sub.maxResultsPerSearch > 0
    ? sub.maxResultsPerSearch : requestedLimit;
  let limit = Math.min(requestedLimit, planCap);
  if (leadHold && leadHold.ok && leadHold.effectiveLimit != null) {
    // Use commercial hold size as-is (may be < 100); do not re-normalize upward.
    limit = Math.min(limit, leadHold.effectiveLimit);
  }

  return {
    mode: 'paid',
    holdToken: null,
    subscription: sub,
    period: window,
    limit,
    leadHold: leadHold || null,
    providers: [...allowed, ...skipped],
  };
}

async function commitProviderMetrics(userId, searchId, providerCode, reservation, metrics) {
  if (!reservation) return null;
  const actualResults = metrics && metrics.rawCount != null ? Number(metrics.rawCount) : 0;
  const actualApiCalls = metrics && metrics.apiCalls != null ? Number(metrics.apiCalls) : 0;
  const geocodeCalls = metrics && metrics.geocodeCalls != null ? Number(metrics.geocodeCalls) : 0;
  const pendingRemote = !!(metrics && metrics.pendingRemote);

  // Never commit actual=0 with pendingRemote via this path when we want to keep the reserve.
  // pendingRemote handling belongs in markPendingRemote / reconciler.
  if (pendingRemote) {
    await markPendingRemote(userId, searchId, providerCode, reservation, metrics);
    return { ok: true, pendingRemote: true };
  }

  const result = await providerUsageService.commit({
    userId,
    providerCode,
    periodStart: reservation.periodStart,
    reservedResults: reservation.reservedResults || 0,
    reservedCostMicroUsd: reservation.reservedCostMicroUsd || 0,
    reservedApiCalls: reservation.reservedApiCalls || 0,
    actualResults: Number.isFinite(actualResults) ? actualResults : 0,
    actualApiCalls: Number.isFinite(actualApiCalls) ? actualApiCalls : 0,
    includeFixedCost: reservation.includeFixedCost != null
      ? reservation.includeFixedCost
      : (providerCode === 'apify'),
    searchId,
    idempotencyKey: `commit:${userId}:${searchId}:${providerCode}`,
    pendingRemote: false,
    unitCostMicroUsd: reservation.unitCostMicroUsd,
    fixedExecutionCostMicroUsd: reservation.fixedExecutionCostMicroUsd,
  });

  if (reservation.global && reservation.global.periodStart && !reservation.global.geo) {
    // Discover quota only — never include geocodeCalls
    let calls = Number.isFinite(actualApiCalls) ? actualApiCalls : 0;
    // Conservative: if Discover request was sent, count at least 1
    if (calls === 0 && metrics && metrics.requestSent) calls = 1;
    calls = Math.min(1, Math.max(0, calls));
    await providerUsageService.commitGlobalTomTomCalls(
      reservation.global.periodStart,
      reservation.global.reservedCalls || 0,
      calls,
      { idempotencyKey: `gcommit:${userId}:${searchId}:tomtom`, searchId, userId }
    );
  }

  // Geocoding is tracked only via metrics.geocodeCalls for audit — never on Discover ledger.

  // Normal path already committed usage. Mark any pending_remote_executions row resolved
  // WITHOUT a second commit (reconciler uses a different idempotency key).
  if (providerCode === 'dataforseo' || providerCode === 'apify' || providerCode === 'brightdata') {
    try {
      await resolvePendingRemoteAfterCommit(userId, searchId, providerCode, {
        results: Number.isFinite(actualResults) ? actualResults : 0,
        apiCalls: Number.isFinite(actualApiCalls) ? actualApiCalls : 0,
      });
    } catch (e) {
      // Non-fatal for the search: usage is already committed; pending row can be cleaned by reconciler skip
      console.error('[resolve-pending-after-commit]', searchId, providerCode, e && e.message);
    }
  }

  return result;
}

/**
 * After a successful normal-path commit, close the pending_remote_executions row
 * without re-committing usage (prevents double billing with reconciler).
 */
/**
 * Normal search path (no reconciler lease): close pending rows after usage was
 * already committed with key commit:user:search:provider.
 *
 * Only updates status = 'pending'. Rows in 'reconciling' stay with the lease
 * owner; resolveSuccess uses the same idempotency key (no double-bill).
 */
async function resolvePendingRemoteAfterCommit(userId, searchId, providerCode, actual = {}) {
  if (!searchId || !providerCode) return { ok: false, reason: 'missing_ids' };
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE pending_remote_executions SET
       status = 'resolved',
       actual_results = COALESCE($4, actual_results),
       actual_api_calls = COALESCE($5, actual_api_calls),
       resolved_at = clock_timestamp(),
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = clock_timestamp(),
       last_error = NULL
     WHERE user_id = $1 AND search_id = $2 AND provider_code = $3
       AND status = 'pending'
       AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
     RETURNING id`,
    [
      userId,
      searchId,
      providerCode,
      actual.results != null ? Number(actual.results) : null,
      actual.apiCalls != null ? Number(actual.apiCalls) : null,
    ]
  );
  return { ok: true, resolved: rows.length, ids: rows.map((r) => r.id) };
}

/**
 * Persist a pending remote execution and KEEP the usage reservation held.
 * Does not call commit/release on provider_usage.
 */
async function markPendingRemote(userId, searchId, providerCode, reservation, metrics = {}, options = {}) {
  if (!reservation || !reservation.periodStart) {
    const err = new Error('markPendingRemote requires reservation.periodStart');
    err.code = 'PENDING_REMOTE_INVALID';
    throw err;
  }
  // Partial unique index and all recovery paths require a real search_id.
  if (searchId == null || searchId === '' || (typeof searchId === 'string' && !searchId.trim())) {
    const err = new Error('markPendingRemote requires a valid searchId');
    err.code = 'PENDING_REMOTE_INVALID_SEARCH_ID';
    throw err;
  }
  if (providerCode !== 'apify' && providerCode !== 'brightdata' && providerCode !== 'dataforseo') return null;

  const externalRunId = metrics.externalRunId || metrics.runId || metrics.snapshotId || null;
  const unknownRemote = !externalRunId && (
    metrics.unknownRemote === true || metrics.allowMissingId === true
  );

  if (!externalRunId && !unknownRemote) {
    const err = new Error('markPendingRemote requires externalRunId/runId/snapshotId');
    err.code = 'PENDING_REMOTE_MISSING_ID';
    throw err;
  }

  const meta = {
    source: 'markPendingRemote',
    global: reservation.global || null,
    unknownRemote: !!unknownRemote,
    reason: metrics.reason || (unknownRemote ? 'remote_id_missing' : null),
    metrics: {
      rawCount: metrics.rawCount,
      apiCalls: metrics.apiCalls,
      geocodeCalls: metrics.geocodeCalls,
      requestSent: metrics.requestSent,
      pendingRemote: metrics.pendingRemote,
    },
  };

  const incomingStatus = unknownRemote ? 'intervention' : 'pending';
  const incomingRunId = externalRunId ? String(externalRunId) : null;

  const externalClient = options.client || null;
  const ownClient = !externalClient;
  const client = externalClient || (await getPool().connect());

  try {
    if (ownClient) {
      await client.query('BEGIN');
      // Same lock key as releaseAllReservations — serializes writers for (search, provider).
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`,
        [String(searchId), String(providerCode)]
      );
    }

    const { rows } = await client.query(
      `INSERT INTO pending_remote_executions (
         user_id, search_id, provider_code, status, external_run_id,
         period_start, reserved_results, reserved_cost_micro_usd, reserved_api_calls,
         unit_cost_micro_usd, fixed_execution_cost_micro_usd, include_fixed_cost,
         pricing_version, metadata, next_attempt_at, last_error
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
         CASE WHEN $4 = 'intervention'
           THEN clock_timestamp() + INTERVAL '100 years'
           ELSE clock_timestamp()
         END,
         CASE WHEN $4 = 'intervention'
           THEN 'remote_id_missing: reservation held for intervention'
           ELSE NULL
         END
       )
       ON CONFLICT (search_id, provider_code)
         WHERE search_id IS NOT NULL
           AND status IN ('pending', 'reconciling', 'intervention')
       DO UPDATE SET
         external_run_id = CASE
           WHEN pending_remote_executions.external_run_id IS NULL
             THEN EXCLUDED.external_run_id
           ELSE pending_remote_executions.external_run_id
         END,
         status = CASE
           WHEN pending_remote_executions.status = 'intervention'
             AND EXCLUDED.external_run_id IS NOT NULL
             THEN 'pending'
           ELSE pending_remote_executions.status
         END,
         next_attempt_at = CASE
           WHEN pending_remote_executions.status = 'intervention'
             AND EXCLUDED.external_run_id IS NOT NULL
             THEN clock_timestamp()
           ELSE pending_remote_executions.next_attempt_at
         END,
         last_error = CASE
           WHEN pending_remote_executions.status = 'intervention'
             AND EXCLUDED.external_run_id IS NOT NULL
             THEN NULL
           ELSE pending_remote_executions.last_error
         END,
         updated_at = clock_timestamp()
       WHERE pending_remote_executions.user_id = EXCLUDED.user_id
         AND pending_remote_executions.period_start = EXCLUDED.period_start
         AND pending_remote_executions.reserved_results = EXCLUDED.reserved_results
         AND pending_remote_executions.reserved_cost_micro_usd = EXCLUDED.reserved_cost_micro_usd
         AND pending_remote_executions.reserved_api_calls = EXCLUDED.reserved_api_calls
         AND pending_remote_executions.unit_cost_micro_usd IS NOT DISTINCT FROM EXCLUDED.unit_cost_micro_usd
         AND pending_remote_executions.fixed_execution_cost_micro_usd IS NOT DISTINCT FROM EXCLUDED.fixed_execution_cost_micro_usd
         AND pending_remote_executions.include_fixed_cost = EXCLUDED.include_fixed_cost
         AND pending_remote_executions.pricing_version IS NOT DISTINCT FROM EXCLUDED.pricing_version
         AND (
           pending_remote_executions.external_run_id IS NULL
           OR EXCLUDED.external_run_id IS NULL
           OR pending_remote_executions.external_run_id = EXCLUDED.external_run_id
         )
       RETURNING id, status, external_run_id`,
      [
        userId,
        searchId,
        providerCode,
        incomingStatus,
        incomingRunId,
        reservation.periodStart,
        reservation.reservedResults || 0,
        String(reservation.reservedCostMicroUsd || 0),
        reservation.reservedApiCalls || 0,
        reservation.unitCostMicroUsd != null ? String(reservation.unitCostMicroUsd) : null,
        reservation.fixedExecutionCostMicroUsd != null ? String(reservation.fixedExecutionCostMicroUsd) : null,
        !!reservation.includeFixedCost,
        reservation.pricingVersion || null,
        JSON.stringify(meta),
      ]
    );

    if (!rows.length) {
      const err = new Error('Existing pending remote execution has a different remote ID or financial reservation');
      err.code = 'PENDING_REMOTE_RESERVATION_CONFLICT';
      throw err;
    }

    if (ownClient) await client.query('COMMIT');
    return {
      ok: true,
      pendingRemote: true,
      id: rows[0].id,
      externalRunId: rows[0].external_run_id || null,
      status: rows[0].status,
    };
  } catch (err) {
    if (ownClient) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw err;
  } finally {
    if (ownClient) client.release();
  }
}

async function commitTrialGlobalTomTom(userId, searchId, globalReserve, metricsByProvider) {
  if (!globalReserve || globalReserve.unlimited || !globalReserve.periodStart) return;
  // Discover quota only — ignore geocodeCalls
  let actual = 0;
  const tomtomMetrics = metricsByProvider && metricsByProvider.tomtom;
  if (tomtomMetrics && Number.isFinite(tomtomMetrics.apiCalls)) {
    actual = Math.min(1, Math.max(0, Number(tomtomMetrics.apiCalls)));
  }
  // Conservative: if request was sent but status error/timeout, still count 1
  if (actual === 0 && tomtomMetrics && tomtomMetrics.requestSent) {
    actual = 1;
  }
  await providerUsageService.commitGlobalTomTomCalls(
    globalReserve.periodStart,
    globalReserve.reservedCalls || 0,
    actual,
    { idempotencyKey: `gcommit-trial:${userId}:${searchId}:tomtom`, searchId, userId }
  );
}

/**
 * Release reservations only when safe.
 * For apify/brightdata after a remote trigger may have started: mark pendingRemote
 * and DO NOT release financial reserves. Reconciler will commit actual or release later.
 *
 * force=true: hard release (admin / confirmed no remote cost).
 */
/**
 * Look up an active pending_remote_executions row for (user, search, provider).
 * Memory objects on cancel/error may lack externalRunId even after onRemoteStarted
 * persisted a row — DB is the source of truth before any financial release.
 */
/**
 * Look up an active pending_remote_executions row for (user, search, provider).
 * When client is provided, runs inside the caller's transaction (must already hold the advisory lock).
 */
async function findActivePendingRemote(userId, searchId, providerCode, client = null) {
  if (!userId || !searchId || !providerCode) return null;
  const q = client || getPool();
  const { rows } = await q.query(
    `SELECT id, status, external_run_id, lease_owner, lease_expires_at
     FROM pending_remote_executions
     WHERE user_id = $1
       AND search_id = $2
       AND provider_code = $3
       AND status IN ('pending', 'reconciling', 'intervention')
     ORDER BY
       CASE status WHEN 'reconciling' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
       created_at ASC
     LIMIT 1
     FOR UPDATE`,
    [userId, searchId, providerCode]
  );
  return rows[0] || null;
}

/**
 * Close an active pending_remote row during administrative force-release.
 * Must run under the same transaction + advisory lock as the financial release.
 */
async function closePendingRemoteAdmin(client, rowId, reason) {
  const { rows } = await client.query(
    `UPDATE pending_remote_executions SET
       status = 'expired',
       last_error = $2,
       lease_owner = NULL,
       lease_expires_at = NULL,
       resolved_at = clock_timestamp(),
       updated_at = clock_timestamp(),
       metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
     WHERE id = $1
       AND status IN ('pending', 'reconciling', 'intervention')
     RETURNING id, status`,
    [
      rowId,
      String(reason || 'admin_force_release').slice(0, 500),
      JSON.stringify({
        admin_force_release: true,
        closed_at: new Date().toISOString(),
        reason: reason || 'admin_force_release',
      }),
    ]
  );
  return rows[0] || null;
}

/**
 * Release reservations only when safe.
 * For remote providers: advisory lock is held for the entire (lookup + protect/release) transaction
 * so markPendingRemote cannot insert an active row between check and financial release.
 *
 * force=true: administrative path — closes active pending_remote rows and releases reserves
 * in the same transaction (explicit no remote cost confirmation by admin).
 */
async function releaseAllReservations(userId, searchId, providers, {
  force = false,
  globalTomTom = null,
  throwOnError = true,
} = {}) {
  const results = [];
  const failures = [];

  for (const p of providers || []) {
    if (!p.allowed || !p.reserve) continue;

    try {
      if (p.code === 'apify' || p.code === 'brightdata' || p.code === 'dataforseo') {
        const metrics = (p.metrics && typeof p.metrics === 'object') ? { ...p.metrics } : {};
        const externalRunId =
          metrics.externalRunId ||
          metrics.runId ||
          metrics.snapshotId ||
          p.externalRunId ||
          p.reserve.externalRunId ||
          p.reserve.runId ||
          p.reserve.snapshotId ||
          null;

        const mayHaveStarted =
          p.pendingRemote === true ||
          metrics.pendingRemote === true ||
          metrics.requestSent === true ||
          p.requestSent === true ||
          p.errorCode === 'REMOTE_PERSIST_FAILED' ||
          metrics.errorCode === 'REMOTE_PERSIST_FAILED';

        const pool = getPool();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`,
            [String(searchId), String(p.code)]
          );

          const activeRow = await findActivePendingRemote(userId, searchId, p.code, client);

          if (activeRow && !force) {
            // Keep reserve held — pending | reconciling | intervention
            await client.query('COMMIT');
            results.push({
              providerCode: p.code,
              action: 'held_existing_pending_remote',
              id: activeRow.id,
              status: activeRow.status,
              externalRunId: activeRow.external_run_id || null,
            });
            continue;
          }

          if (activeRow && force) {
            // Administrative force: close remote row + release finance atomically
            await closePendingRemoteAdmin(
              client,
              activeRow.id,
              'admin_force_release: no remote cost confirmed'
            );
            await providerUsageService.release({
              userId,
              providerCode: p.code,
              periodStart: p.reserve.periodStart,
              reservedResults: p.reserve.reservedResults || 0,
              reservedCostMicroUsd: p.reserve.reservedCostMicroUsd || 0,
              reservedApiCalls: p.reserve.reservedApiCalls || 0,
              searchId,
              idempotencyKey: `release:${userId}:${searchId}:${p.code}`,
              client,
              reason: 'admin_force_release',
            });
            if (p.reserve.global && p.reserve.global.periodStart && !p.reserve.global.geo) {
              await providerUsageService.releaseGlobalTomTomCalls(
                p.reserve.global.periodStart,
                p.reserve.global.reservedCalls || 0,
                { idempotencyKey: `grelease:${userId}:${searchId}:${p.code}:tomtom`, searchId, userId, client }
              );
            }
            await client.query('COMMIT');
            results.push({
              providerCode: p.code,
              action: 'force_released',
              id: activeRow.id,
              closedStatus: 'expired',
            });
            continue;
          }

          // No active row under lock
          if (!force && externalRunId) {
            const held = await markPendingRemote(
              userId, searchId, p.code, p.reserve,
              { ...metrics, externalRunId, pendingRemote: true, reason: 'release_protect_known_remote' },
              { client }
            );
            if (!held || !held.id) {
              const err = new Error('markPendingRemote did not persist pending row');
              err.code = 'PENDING_REMOTE_PERSIST_FAILED';
              throw err;
            }
            await client.query('COMMIT');
            results.push({ providerCode: p.code, action: 'held_pending_remote', id: held.id });
            continue;
          }

          if (!force && mayHaveStarted) {
            const held = await markPendingRemote(
              userId, searchId, p.code, p.reserve,
              {
                ...metrics,
                unknownRemote: true,
                allowMissingId: true,
                pendingRemote: true,
                reason: 'release_protect_unknown_remote',
              },
              { client }
            );
            if (!held || !held.id) {
              const err = new Error('markPendingRemote did not persist intervention row');
              err.code = 'PENDING_REMOTE_PERSIST_FAILED';
              throw err;
            }
            await client.query('COMMIT');
            results.push({ providerCode: p.code, action: 'held_intervention', id: held.id });
            continue;
          }

          // Safe to release financially while still holding the lock
          await providerUsageService.release({
            userId,
            providerCode: p.code,
            periodStart: p.reserve.periodStart,
            reservedResults: p.reserve.reservedResults || 0,
            reservedCostMicroUsd: p.reserve.reservedCostMicroUsd || 0,
            reservedApiCalls: p.reserve.reservedApiCalls || 0,
            searchId,
            idempotencyKey: `release:${userId}:${searchId}:${p.code}`,
            client,
          });
          if (p.reserve.global && p.reserve.global.periodStart && !p.reserve.global.geo) {
            await providerUsageService.releaseGlobalTomTomCalls(
              p.reserve.global.periodStart,
              p.reserve.global.reservedCalls || 0,
              { idempotencyKey: `grelease:${userId}:${searchId}:${p.code}:tomtom`, searchId, userId, client }
            );
          }
          await client.query('COMMIT');
          results.push({ providerCode: p.code, action: 'released' });
        } catch (innerErr) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw innerErr;
        } finally {
          client.release();
        }
        continue;
      }

      // Non-remote providers (e.g. tomtom per-user) — no pending_remote path
      await providerUsageService.release({
        userId,
        providerCode: p.code,
        periodStart: p.reserve.periodStart,
        reservedResults: p.reserve.reservedResults || 0,
        reservedCostMicroUsd: p.reserve.reservedCostMicroUsd || 0,
        reservedApiCalls: p.reserve.reservedApiCalls || 0,
        searchId,
        idempotencyKey: `release:${userId}:${searchId}:${p.code}`,
      });
      if (p.reserve.global && p.reserve.global.periodStart && !p.reserve.global.geo) {
        await providerUsageService.releaseGlobalTomTomCalls(
          p.reserve.global.periodStart,
          p.reserve.global.reservedCalls || 0,
          { idempotencyKey: `grelease:${userId}:${searchId}:${p.code}:tomtom`, searchId, userId }
        );
      }
      results.push({ providerCode: p.code, action: 'released' });
    } catch (err) {
      failures.push({
        providerCode: p.code,
        code: err && err.code ? err.code : 'RESERVATION_RELEASE_FAILED',
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  if (globalTomTom && globalTomTom.periodStart && !globalTomTom.unlimited) {
    try {
      await providerUsageService.releaseGlobalTomTomCalls(
        globalTomTom.periodStart,
        globalTomTom.reservedCalls || 0,
        { idempotencyKey: `grelease-trial:${userId}:${searchId}:tomtom`, searchId, userId }
      );
      results.push({ providerCode: 'tomtom_global', action: 'released_global' });
    } catch (err) {
      failures.push({
        providerCode: 'tomtom_global',
        code: err && err.code ? err.code : 'GLOBAL_RELEASE_FAILED',
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  const summary = {
    ok: failures.length === 0,
    results,
    failures,
  };

  if (!summary.ok && throwOnError) {
    const err = new Error(
      `Failed to reconcile ${failures.length} financial reservation(s)`
    );
    err.code = 'RELEASE_RESERVATIONS_FAILED';
    err.failures = failures;
    err.results = results;
    throw err;
  }

  return summary;
}

async function getClientQuotaView(userId) {
  const pool = getPool();
  const { rows: userRows } = await pool.query(
    `SELECT free_search_used, free_search_hold_token, free_search_hold_until FROM users WHERE id = $1`,
    [userId]
  );
  const u = userRows[0] || {};
  const trialAvailable = !u.free_search_used
    && (!u.free_search_hold_token || !u.free_search_hold_until || new Date(u.free_search_hold_until) < new Date());

  const sub = await subscriptionService.getActiveSubscription(userId);
  let period = null;
  let usage = [];
  let limits = [];
  if (sub) {
    period = subscriptionService.resolvePeriodWindow(sub, new Date());
    if (period) {
      usage = await providerUsageService.getUserUsageSummary(userId, period.periodStart);
      limits = await planService.listProviderLimits(sub.planId);
    }
  }

  function remainingFor(code) {
    const lim = limits.find((l) => l.providerCode === code);
    const def = DEFAULT_PAID_LIMITS[code];
    const max = lim && lim.maxResultsPerPeriod != null ? lim.maxResultsPerPeriod
      : (def && def.maxResults != null ? def.maxResults : null);
    const row = usage.find((x) => x.providerCode === code);
    const used = row ? row.resultsUsed + row.resultsReserved : 0;
    if (max == null) return { max: null, used, remaining: null };
    return { max, used, remaining: Math.max(0, max - used) };
  }

  // Client-facing consumption: final delivered leads (total_after_filters).
  // Paid: current subscription cycle. Trial: all completed/partial trial searches.
  // Exclude failed/cancelled. Do not sum provider raw quotas.
  let deliveredResults = 0;
  let duplicatesRemoved = 0;
  let planLimit = null;
  const trialInProgress = Boolean(
    u.free_search_hold_token && u.free_search_hold_until
    && new Date(u.free_search_hold_until) > new Date() && !u.free_search_used
  );
  const trialUsed = Boolean(u.free_search_used);

  if (sub && period && period.periodStart && period.periodEnd) {
    const { rows: delRows } = await pool.query(
      `SELECT
         COALESCE(SUM(total_after_filters), 0)::int AS delivered,
         COALESCE(SUM(GREATEST(COALESCE(total_normalized, 0) - COALESCE(total_after_dedup, 0), 0)), 0)::int AS dupes
       FROM searches
       WHERE user_id = $1
         AND status IN ('completed', 'partial')
         AND completed_at IS NOT NULL
         AND completed_at >= $2::timestamptz
         AND completed_at < $3::timestamptz
         AND COALESCE(filters->>'quotaMode', '') = 'paid'`,
      [userId, period.periodStart, period.periodEnd]
    );
    deliveredResults = delRows[0] ? Number(delRows[0].delivered) || 0 : 0;
    duplicatesRemoved = delRows[0] ? Number(delRows[0].dupes) || 0 : 0;
    if (sub.maxResultsPerMonth != null && Number(sub.maxResultsPerMonth) > 0) {
      planLimit = Number(sub.maxResultsPerMonth);
    }
  } else {
    const { rows: trialRows } = await pool.query(
      `SELECT
         COALESCE(SUM(total_after_filters), 0)::int AS delivered,
         COALESCE(SUM(GREATEST(COALESCE(total_normalized, 0) - COALESCE(total_after_dedup, 0), 0)), 0)::int AS dupes
       FROM searches
       WHERE user_id = $1
         AND status IN ('completed', 'partial')
         AND completed_at IS NOT NULL
         AND COALESCE(filters->>'quotaMode', '') = 'trial'`,
      [userId]
    );
    deliveredResults = trialRows[0] ? Number(trialRows[0].delivered) || 0 : 0;
    duplicatesRemoved = trialRows[0] ? Number(trialRows[0].dupes) || 0 : 0;
    planLimit = TRIAL_MAX_LEADS;
    if (trialUsed && deliveredResults === 0) {
      // Trial consumed (flag set) but no countable rows — treat as fully used.
      deliveredResults = TRIAL_MAX_LEADS;
    }
  }

  let reservedLeads = 0;
  if (sub && period && period.periodStart) {
    try {
      reservedLeads = await leadQuotaService.getReservedForUser(userId, period.periodStart);
    } catch (resErr) {
      const err = new Error('Não foi possível calcular leads reservados neste ciclo.');
      err.code = 'QUOTA_VIEW_RESERVED_FAILED';
      err.cause = resErr;
      throw err;
    }
  }
  const remaining = planLimit != null
    ? Math.max(0, planLimit - deliveredResults - reservedLeads)
    : null;

  let planStatus = 'Disponível';
  if (sub) {
    const st = String(sub.status || '').toLowerCase();
    if (st === 'active') planStatus = 'Activo';
    else if (st === 'cancelled' || st === 'canceled') planStatus = 'Cancelado';
    else if (st === 'expired') planStatus = 'Expirado';
    else if (st === 'pending') planStatus = 'Pendente';
    else planStatus = sub.status || 'Activo';
  } else if (trialInProgress) {
    planStatus = 'Activo';
  } else if (trialUsed || (planLimit != null && deliveredResults >= planLimit)) {
    planStatus = 'Concluído';
  } else if (trialAvailable) {
    planStatus = 'Disponível';
  }

  return {
    trial: {
      available: trialAvailable && !trialUsed,
      used: trialUsed,
      maxLeads: TRIAL_MAX_LEADS,
      inProgress: trialInProgress,
    },
    subscription: sub ? {
      id: sub.id, status: sub.status, planId: sub.planId, planName: sub.planName,
      startsAt: sub.startsAt, endsAt: sub.endsAt, nextRenewalAt: sub.endsAt,
      maxResultsPerMonth: sub.maxResultsPerMonth != null ? Number(sub.maxResultsPerMonth) : null,
      maxResultsPerSearch: sub.maxResultsPerSearch != null ? Number(sub.maxResultsPerSearch) : null,
      periodDays: period && period.periodDays != null ? period.periodDays : (sub.periodDays != null ? sub.periodDays : null),
      priceCents: sub.priceCents != null ? Number(sub.priceCents) : null,
      currency: sub.currency || 'USD',
    } : null,
    period,
    // Unified client-facing plan + usage (trial and paid share this shape)
    currentPlan: {
      type: sub ? 'paid' : 'trial',
      name: sub ? (sub.planName || 'Plano') : 'Trial',
      status: planStatus,
      priceCents: sub && sub.priceCents != null ? Number(sub.priceCents) : null,
      currency: sub ? (sub.currency || 'USD') : null,
      startsAt: sub ? sub.startsAt : null,
      endsAt: sub ? (sub.endsAt || sub.nextRenewalAt) : null,
      periodDays: sub
        ? (period && period.periodDays != null ? period.periodDays : sub.periodDays)
        : null,
    },
    usage: {
      deliveredResults,
      reservedLeads,
      availableLeads: remaining,
      planLimit,
      remaining,
      duplicatesRemoved,
    },
    // Internal provider quotas kept for admin/debug; client UI must not render these.
    providers: {
      apify: remainingFor('apify'),
      brightdata: remainingFor('brightdata'),
      tomtom: remainingFor('tomtom'),
    },
  };
}

module.exports = {
  findActivePendingRemote,
  TRIAL_MAX_LEADS, DEFAULT_PAID_LIMITS,
  authorizeAndReserve, commitProviderMetrics, commitTrialGlobalTomTom,
  releaseAllReservations, markPendingRemote, resolvePendingRemoteAfterCommit, getClientQuotaView,
};
