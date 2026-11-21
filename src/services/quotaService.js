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
const providerUsageService = require('./providerUsageService');
const { acquireFreeSearchHold } = require('./freeSearchHold');
const { PROVIDER_MAX } = require('./searchEngine');

const TRIAL_MAX_LEADS = 200;
const DEFAULT_PAID_LIMITS = Object.freeze({
  apify: { maxResults: 1000, maxCostMicroUsd: null },
  brightdata: { maxResults: 1500, maxCostMicroUsd: null },
  tomtom: { maxResults: null, maxCostMicroUsd: null, maxApiCalls: null },
});

function getPool() {
  return require('../db/pool').getPool();
}

/**
 * Reserve global TomTom calls when the provider list includes tomtom or when
 * Bright Data may perform geocoding (1 call). Used by both trial and paid paths.
 */
async function reserveTrialGlobalTomTom(userId, searchId, providerCodes) {
  const needsTomTom = providerCodes.includes('tomtom');
  const needsGeo = providerCodes.includes('brightdata');
  let estCalls = 0;
  if (needsTomTom) estCalls += Math.max(3, Math.ceil(TRIAL_MAX_LEADS / 100) + 1);
  if (needsGeo) estCalls += 1;
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
  providerCodes = ['apify', 'brightdata', 'tomtom'],
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

  const planLimits = await planService.listProviderLimits(sub.planId);
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
      const estCalls = Math.max(3, Math.ceil(wantResults / 100) + 1);
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

    // Bright Data geocode: pre-reserve is mandatory before any TomTom geocode call.
    // If pre-reserve fails, mark geoBlocked so provider must not call TomTom.
    if (code === 'brightdata') {
      const geoReserve = await providerUsageService.reserveGlobalTomTomCalls(1, {
        searchId,
        userId,
        idempotencyKey: `greserve-geo:${userId}:${searchId}:bd`,
      });
      if (!geoReserve.ok) {
        geoBlocked = true;
      } else if (!geoReserve.unlimited) {
        globalReserve = globalReserve || {};
        globalReserve.geo = geoReserve;
      }
    }

    const reserveResult = await providerUsageService.reserve({
      userId,
      providerCode: code,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      results: wantResults,
      apiCalls: code === 'tomtom' ? Math.max(3, Math.ceil(wantResults / 100) + 1) : 1,
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

  return {
    mode: 'paid',
    holdToken: null,
    subscription: sub,
    period: window,
    limit: Math.min(requestedLimit, planCap),
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
    const calls = (Number.isFinite(actualApiCalls) ? actualApiCalls : 0)
      + (Number.isFinite(geocodeCalls) ? geocodeCalls : 0);
    await providerUsageService.commitGlobalTomTomCalls(
      reservation.global.periodStart,
      reservation.global.reservedCalls || 0,
      calls,
      { idempotencyKey: `gcommit:${userId}:${searchId}:tomtom`, searchId, userId }
    );
  }

  if (reservation.global && reservation.global.geo && reservation.global.geo.periodStart) {
    const usedGeo = Number.isFinite(geocodeCalls) ? geocodeCalls : 0;
    await providerUsageService.commitGlobalTomTomCalls(
      reservation.global.geo.periodStart,
      reservation.global.geo.reservedCalls || 0,
      usedGeo,
      { idempotencyKey: `gcommit-geo:${userId}:${searchId}:bd`, searchId, userId }
    );
  }
  // No post-facto / late reserve path — geocode must be pre-reserved.

  return result;
}

/**
 * Persist a pending remote execution and KEEP the usage reservation held.
 * Does not call commit/release on provider_usage.
 */
async function markPendingRemote(userId, searchId, providerCode, reservation, metrics = {}) {
  if (!reservation || !reservation.periodStart) {
    const err = new Error('markPendingRemote requires reservation.periodStart');
    err.code = 'PENDING_REMOTE_INVALID';
    throw err;
  }
  if (providerCode !== 'apify' && providerCode !== 'brightdata') return null;

  const externalRunId = metrics.externalRunId || metrics.runId || metrics.snapshotId || null;
  if (!externalRunId) {
    const err = new Error('markPendingRemote requires externalRunId/runId/snapshotId');
    err.code = 'PENDING_REMOTE_MISSING_ID';
    throw err;
  }

  const pool = getPool();
  // Fail explicitly — callers must not treat persistence failure as success
  const { rows } = await pool.query(
    `INSERT INTO pending_remote_executions (
       user_id, search_id, provider_code, status, external_run_id,
       period_start, reserved_results, reserved_cost_micro_usd, reserved_api_calls,
       unit_cost_micro_usd, fixed_execution_cost_micro_usd, include_fixed_cost,
       pricing_version, metadata
     ) VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT (search_id, provider_code)
       WHERE search_id IS NOT NULL AND status IN ('pending', 'reconciling')
     DO UPDATE SET
       external_run_id = COALESCE(EXCLUDED.external_run_id, pending_remote_executions.external_run_id),
       updated_at = NOW()
     RETURNING id`,
    [
      userId,
      searchId,
      providerCode,
      String(externalRunId),
      reservation.periodStart,
      reservation.reservedResults || 0,
      String(reservation.reservedCostMicroUsd || 0),
      reservation.reservedApiCalls || 0,
      reservation.unitCostMicroUsd != null ? String(reservation.unitCostMicroUsd) : null,
      reservation.fixedExecutionCostMicroUsd != null ? String(reservation.fixedExecutionCostMicroUsd) : null,
      !!reservation.includeFixedCost,
      reservation.pricingVersion || null,
      JSON.stringify({
        source: 'markPendingRemote',
        global: reservation.global || null,
        metrics: {
          rawCount: metrics.rawCount,
          apiCalls: metrics.apiCalls,
          geocodeCalls: metrics.geocodeCalls,
        },
      }),
    ]
  );
  return { ok: true, pendingRemote: true, id: rows[0] && rows[0].id, externalRunId: String(externalRunId) };
}

async function commitTrialGlobalTomTom(userId, searchId, globalReserve, metricsByProvider) {
  if (!globalReserve || globalReserve.unlimited || !globalReserve.periodStart) return;
  let actual = 0;
  for (const m of Object.values(metricsByProvider || {})) {
    if (m && Number.isFinite(m.apiCalls)) actual += m.apiCalls;
    if (m && Number.isFinite(m.geocodeCalls)) actual += m.geocodeCalls;
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
async function releaseAllReservations(userId, searchId, providers, { force = false, globalTomTom = null } = {}) {
  for (const p of providers || []) {
    if (!p.allowed || !p.reserve) continue;
    try {
      if (!force && (p.code === 'apify' || p.code === 'brightdata')) {
        // Keep reservation; record pending remote for reconciliation.
        await markPendingRemote(userId, searchId, p.code, p.reserve, {
          pendingRemote: true,
        });
        // Do NOT commit or release provider_usage here.
        continue;
      }

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
          p.reserve.global.periodStart, p.reserve.global.reservedCalls || 0,
          { idempotencyKey: `grelease:${userId}:${searchId}:${p.code}:tomtom`, searchId, userId }
        );
      }
      if (p.reserve.global && p.reserve.global.geo && p.reserve.global.geo.periodStart) {
        await providerUsageService.releaseGlobalTomTomCalls(
          p.reserve.global.geo.periodStart, p.reserve.global.geo.reservedCalls || 0,
          { idempotencyKey: `grelease-geo:${userId}:${searchId}:bd`, searchId, userId }
        );
      }
    } catch (_) { /* best-effort */ }
  }

  if (globalTomTom && globalTomTom.periodStart && !globalTomTom.unlimited) {
    try {
      await providerUsageService.releaseGlobalTomTomCalls(
        globalTomTom.periodStart, globalTomTom.reservedCalls || 0,
        { idempotencyKey: `grelease-trial:${userId}:${searchId}:tomtom`, searchId, userId }
      );
    } catch (_) { /* best-effort */ }
  }
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

  const remaining = planLimit != null ? Math.max(0, planLimit - deliveredResults) : null;

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
  TRIAL_MAX_LEADS, DEFAULT_PAID_LIMITS,
  authorizeAndReserve, commitProviderMetrics, commitTrialGlobalTomTom,
  releaseAllReservations, markPendingRemote, getClientQuotaView,
};
