/**
 * Authorisation gate: trial vs paid quotas per provider.
 * Policy: if trial still available, prefer trial (does not consume paid quotas).
 * Paid path only when free_search_used or hold blocked for non-in-progress reasons.
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
    return {
      mode: 'trial',
      holdToken: hold.holdToken,
      holdUntil: hold.holdUntil,
      limit: Math.min(requestedLimit, TRIAL_MAX_LEADS),
      providers: providerCodes.map((code) => ({ code, allowed: true, reason: null, reserve: null })),
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

  // Period window uses immutable subscription.periodDays (not mutable global setting)
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
      if (globalReserve && globalReserve.ok && !globalReserve.unlimited) {
        await providerUsageService.releaseGlobalTomTomCalls(
          globalReserve.periodStart, globalReserve.reservedCalls, {
            idempotencyKey: `grelease:${userId}:${searchId}:tomtom`,
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
      reserve: {
        ...reserveResult,
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        global: globalReserve && !globalReserve.unlimited ? globalReserve : null,
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

  const result = await providerUsageService.commit({
    userId,
    providerCode,
    periodStart: reservation.periodStart,
    reservedResults: reservation.reservedResults || 0,
    reservedCostMicroUsd: reservation.reservedCostMicroUsd || 0,
    reservedApiCalls: reservation.reservedApiCalls || 0,
    actualResults: Number.isFinite(actualResults) ? actualResults : 0,
    actualApiCalls: Number.isFinite(actualApiCalls) ? actualApiCalls : 0,
    includeFixedCost: providerCode === 'apify',
    searchId,
    idempotencyKey: `commit:${userId}:${searchId}:${providerCode}`,
    pendingRemote,
  });

  if (reservation.global && reservation.global.periodStart) {
    const calls = (Number.isFinite(actualApiCalls) ? actualApiCalls : 0)
      + (Number.isFinite(geocodeCalls) ? geocodeCalls : 0);
    await providerUsageService.commitGlobalTomTomCalls(
      reservation.global.periodStart,
      reservation.global.reservedCalls || 0,
      calls,
      { idempotencyKey: `gcommit:${userId}:${searchId}:tomtom`, searchId, userId }
    );
  }

  if (providerCode === 'brightdata' && geocodeCalls > 0) {
    const g = await providerUsageService.reserveGlobalTomTomCalls(geocodeCalls, {
      searchId,
      userId,
      idempotencyKey: `greserve-geo:${userId}:${searchId}:bd`,
    });
    if (g.ok && !g.unlimited) {
      await providerUsageService.commitGlobalTomTomCalls(
        g.periodStart, g.reservedCalls, geocodeCalls,
        { idempotencyKey: `gcommit-geo:${userId}:${searchId}:bd`, searchId, userId }
      );
    }
  }

  return result;
}

/**
 * Release only when safe (no pending remote cost risk).
 * For apify/brightdata failures after trigger, prefer commit with actualResults=0 + pendingRemote
 * rather than silent release when execution may have been billed.
 */
async function releaseAllReservations(userId, searchId, providers, { force = false } = {}) {
  for (const p of providers || []) {
    if (!p.allowed || !p.reserve) continue;
    try {
      if (!force && (p.code === 'apify' || p.code === 'brightdata')) {
        // Commit zero results but keep audit trail; fixed cost may still apply for apify if flagged
        await providerUsageService.commit({
          userId,
          providerCode: p.code,
          periodStart: p.reserve.periodStart,
          reservedResults: p.reserve.reservedResults || 0,
          reservedCostMicroUsd: p.reserve.reservedCostMicroUsd || 0,
          reservedApiCalls: p.reserve.reservedApiCalls || 0,
          actualResults: 0,
          actualApiCalls: 0,
          includeFixedCost: false,
          searchId,
          idempotencyKey: `commit-fail:${userId}:${searchId}:${p.code}`,
          pendingRemote: true,
        });
      } else {
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
      }
      if (p.reserve.global && p.reserve.global.periodStart) {
        await providerUsageService.releaseGlobalTomTomCalls(
          p.reserve.global.periodStart, p.reserve.global.reservedCalls || 0,
          { idempotencyKey: `grelease:${userId}:${searchId}:${p.code}:tomtom`, searchId, userId }
        );
      }
    } catch (_) { /* best-effort */ }
  }
}

async function getClientQuotaView(userId) {
  const pool = require('../db/pool').getPool();
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

  return {
    trial: {
      available: Boolean(trialAvailable),
      used: Boolean(u.free_search_used),
      maxLeads: TRIAL_MAX_LEADS,
      inProgress: Boolean(
        u.free_search_hold_token && u.free_search_hold_until
        && new Date(u.free_search_hold_until) > new Date() && !u.free_search_used
      ),
    },
    subscription: sub ? {
      id: sub.id, status: sub.status, planId: sub.planId, planName: sub.planName,
      startsAt: sub.startsAt, endsAt: sub.endsAt, nextRenewalAt: sub.endsAt,
    } : null,
    period,
    providers: {
      apify: remainingFor('apify'),
      brightdata: remainingFor('brightdata'),
      tomtom: remainingFor('tomtom'),
    },
  };
}

module.exports = {
  TRIAL_MAX_LEADS, DEFAULT_PAID_LIMITS,
  authorizeAndReserve, commitProviderMetrics, releaseAllReservations, getClientQuotaView,
};
