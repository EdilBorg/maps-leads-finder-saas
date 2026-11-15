/**
 * Persist searches / results / leads with multi-tenant isolation.
 * Async start: creates search, returns searchId, runs providers in background.
 * Cancel: AbortController + status gate before persist (no results if cancelled).
 * Free-search: atomic hold + validated consume in the same TX as result inserts.
 * GLOBAL LOCK ORDER: users → searches.
 * Incremental provider progress is written to searches.providers_used while status=running.
 */
function getPool() {
  return require('../db/pool').getPool();
}
const {
  executeSearch,
  publicLead,
  clientMessageForOutcome,
  clientHintForOutcome,
  normalizeLimit,
  leadIdentityKey,
} = require('./searchEngine');
const {
  acquireFreeSearchHold,
  bindHoldToSearch,
  renewFreeSearchHold,
  consumeFreeSearchHold,
  releaseFreeSearchHold,
  lockUserForUpdate,
  recoverAbandonedSearches,
  FREE_SEARCH_HOLD_MINUTES,
  FREE_SEARCH_RENEW_INTERVAL_MS,
} = require('./freeSearchHold');

const {
  listSavedLeads,
  getSavedLead,
  updateSavedLead,
  CRM_STATUSES,
  CRM_NOTES_MAX,
  isValidCrmStatus,
} = require('./savedLeadsCrm');

const RETENTION_DAYS = 30;

/** @type {Map<string, { controller: AbortController, userId: string }>} */
const activeRuns = new Map();

function mapPublicRow(r, i) {
  const raw = r.raw_payload && typeof r.raw_payload === 'object' ? r.raw_payload : {};
  return publicLead({
    id: r.id, name: r.name, address: r.address, phone: r.phone, email: r.email, website: r.website,
    rating: r.rating != null ? Number(r.rating) : null, reviewsCount: r.reviews_count,
    category: r.category, lat: r.lat, lng: r.lng,
    photoUrl: raw.photoUrl || null,
    googleMapsUrl: raw.googleMapsUrl || raw.url || null,
    googlePlaceId: raw.placeId || raw.googlePlaceId || null,
    sourceProvider: r.source_provider || null,
    externalId: r.external_id || null,
    raw,
  }, i);
}

function mapProviderUiStatus(status, errorCode) {
  if (errorCode === 'CANCELLED' || status === 'cancelled') return 'cancelled';
  if (status === 'ok') return 'completed';
  if (status === 'empty') return 'no_results';
  if (status === 'not_configured') return 'not_configured';
  if (status === 'running' || status === 'pending') return status;
  return 'failed';
}

function markPendingProvidersCancelled(providers) {
  if (!Array.isArray(providers)) return [];
  return providers.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const st = p.status;
    if (st === 'pending' || st === 'running') {
      return { ...p, status: 'cancelled' };
    }
    return p;
  });
}

async function updateProviderProgress(pool, searchId, userId, progress) {
  const code = progress && progress.code;
  if (!code) return;
  const uiStatus = mapProviderUiStatus(progress.status, progress.errorCode);
  const count = typeof progress.count === 'number' ? progress.count : 0;
  const entry = { code, status: uiStatus, count };
  if (progress.errorCode) entry.errorCode = progress.errorCode;
  if (progress.durationMs != null) entry.durationMs = progress.durationMs;
  try {
    await pool.query(
      `UPDATE searches\n       SET providers_used = (\n         SELECT COALESCE(jsonb_agg(\n           CASE\n             WHEN elem->>'code' = $3 THEN $4::jsonb\n             ELSE elem\n           END\n           ORDER BY ord\n         ), '[]'::jsonb)\n         FROM jsonb_array_elements(providers_used) WITH ORDINALITY AS t(elem, ord)\n       )\n       WHERE id = $1 AND user_id = $2 AND status = 'running'`,
      [searchId, userId, code, JSON.stringify(entry)]
    );
  } catch (err) {
    console.error('[provider-progress]', searchId, code, err && err.message ? err.message : err);
  }
}

function startHoldRenewal(userId, holdToken, opts = {}) {
  let stopped = false;
  let inFlight = false;
  const searchId = opts.searchId || null;
  const getPoolFn = opts.getPool || getPool;
  const renewFn = opts.renewFn || renewFreeSearchHold;
  const logFn = opts.log || ((msg, extra) => {
    console.error(`[hold-renewal] ${msg}`, extra ? JSON.stringify(extra) : '');
  });
  const intervalMs = opts.intervalMs != null ? opts.intervalMs : FREE_SEARCH_RENEW_INTERVAL_MS;

  const timer = setInterval(() => {
    if (stopped || !holdToken || inFlight) return;
    inFlight = true;
    (async () => {
      let client = null;
      try {
        let pool;
        try { pool = getPoolFn(); }
        catch (err) {
          logFn('connect_error', { userId, searchId, message: err && err.message ? err.message : String(err) });
          return;
        }
        try { client = await pool.connect(); }
        catch (err) {
          logFn('connect_error', { userId, searchId, message: err && err.message ? err.message : String(err) });
          return;
        }
        if (stopped) return;
        try {
          const r = await renewFn(client, userId, holdToken);
          if (!r || !r.renewed) {
            stopped = true;
            clearInterval(timer);
            logFn('not_renewable', { userId, searchId });
          }
        } catch (err) {
          logFn('renew_error', { userId, searchId, message: err && err.message ? err.message : String(err) });
        }
      } catch (err) {
        logFn('unexpected_error', { userId, searchId, message: err && err.message ? err.message : String(err) });
      } finally {
        if (client) { try { client.release(); } catch (_) {} }
        inFlight = false;
      }
    })();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

async function markSearchFailed(pool, searchId, userId, summary) {
  await pool.query(
    `UPDATE searches SET status='failed', completed_at=NOW(), error_summary=$2\n     WHERE id=$1 AND user_id=$3 AND status IN ('running','failed')`,
    [searchId, summary, userId]
  );
}

async function startSearch(opts) {
  const pool = getPool();
  let searchId = null;
  let holdToken = null;

  {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const hold = await acquireFreeSearchHold(client, opts.userId, null);
      if (!hold.allowed) {
        await client.query('ROLLBACK');
        const err = new Error(
          hold.reason === 'FREE_SEARCH_IN_PROGRESS'
            ? 'Já existe uma pesquisa gratuita em curso. Aguarde ou tente mais tarde.'
            : 'Quota gratuita indisponível.'
        );
        err.code = 'QUOTA';
        err.reason = hold.reason;
        throw err;
      }
      holdToken = hold.holdToken;
      const limit = normalizeLimit(opts.limit);
      const ins = await client.query(
        `INSERT INTO searches (\n           user_id, query, location, filters, status, providers_used, started_at, expires_at\n         ) VALUES ($1,$2,$3,$4::jsonb,'running',$5::jsonb,NOW(), NOW() + ($6 || ' days')::interval)\n         RETURNING id`,
        [
          opts.userId, opts.query, opts.location,
          JSON.stringify({ ...(opts.filters || {}), limit, holdToken }),
          JSON.stringify([
            { code: 'apify', status: 'pending', count: 0 },
            { code: 'tomtom', status: 'pending', count: 0 },
            { code: 'foursquare', status: 'pending', count: 0 },
          ]),
          String(RETENTION_DAYS),
        ]
      );
      searchId = ins.rows[0].id;
      const bound = await bindHoldToSearch(client, opts.userId, holdToken, searchId);
      if (!bound) {
        await client.query('ROLLBACK');
        try { await releaseFreeSearchHold(client, opts.userId, holdToken); } catch (_) {}
        const err = new Error('Não foi possível associar a reserva à pesquisa. Tenta novamente.');
        err.code = 'HOLD_BIND_FAILED';
        throw err;
      }
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (holdToken && err.code !== 'QUOTA' && err.code !== 'HOLD_BIND_FAILED') {
        try { await releaseFreeSearchHold(client, opts.userId, holdToken); } catch (_) {}
      }
      client.release();
      throw err;
    }
    client.release();
  }

  const controller = new AbortController();
  activeRuns.set(String(searchId), { controller, userId: opts.userId, holdToken });

  setImmediate(() => {
    runSearchJob({
      searchId,
      userId: opts.userId,
      query: opts.query,
      location: opts.location,
      filters: opts.filters,
      limit: opts.limit,
      holdToken,
      controller,
      executeSearchFn: opts.executeSearchFn,
    }).catch((err) => {
      console.error('[search-job]', searchId, err && err.message ? err.message : err);
    });
  });

  return { searchId, status: 'running' };
}

module.exports = {
  startSearch,
  listSavedLeads,
  getSavedLead,
  updateSavedLead,
  CRM_STATUSES,
  CRM_NOTES_MAX,
  isValidCrmStatus,
  recoverAbandonedSearches,
  FREE_SEARCH_HOLD_MINUTES,
  activeRuns,
  markPendingProvidersCancelled,
};
