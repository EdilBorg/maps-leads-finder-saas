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
      `UPDATE searches
       SET providers_used = (
         SELECT COALESCE(jsonb_agg(
           CASE
             WHEN elem->>'code' = $3 THEN $4::jsonb
             ELSE elem
           END
           ORDER BY ord
         ), '[]'::jsonb)
         FROM jsonb_array_elements(providers_used) WITH ORDINALITY AS t(elem, ord)
       )
       WHERE id = $1 AND user_id = $2 AND status = 'running'`,
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
    `UPDATE searches SET status='failed', completed_at=NOW(), error_summary=$2
     WHERE id=$1 AND user_id=$3 AND status IN ('running','failed')`,
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
        `INSERT INTO searches (
           user_id, query, location, filters, status, providers_used, started_at, expires_at
         ) VALUES ($1,$2,$3,$4::jsonb,'running',$5::jsonb,NOW(), NOW() + ($6 || ' days')::interval)
         RETURNING id`,
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

async function runSearchJob(ctx) {
  const pool = getPool();
  const stopRenewal = startHoldRenewal(ctx.userId, ctx.holdToken, { searchId: ctx.searchId });
  let engineResult;
  try {
    const runEngine = ctx.executeSearchFn || executeSearch;
    engineResult = await runEngine(
      { query: ctx.query, location: ctx.location, filters: ctx.filters, limit: ctx.limit },
      {
        signal: ctx.controller.signal,
        onProviderProgress: (progress) => {
          updateProviderProgress(pool, ctx.searchId, ctx.userId, progress).catch(() => {});
        },
      }
    );
  } catch (err) {
    stopRenewal();
    activeRuns.delete(String(ctx.searchId));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockUserForUpdate(client, ctx.userId);
      const st = await client.query(
        `SELECT status FROM searches WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [ctx.searchId, ctx.userId]
      );
      if (st.rows[0] && st.rows[0].status === 'cancelled') {
        await releaseFreeSearchHold(client, ctx.userId, ctx.holdToken);
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `UPDATE searches SET status='failed', completed_at=NOW(), error_summary=$2 WHERE id=$1 AND user_id=$3 AND status='running'`,
        [ctx.searchId, err.message || 'engine error', ctx.userId]
      );
      await releaseFreeSearchHold(client, ctx.userId, ctx.holdToken);
      await client.query('COMMIT');
    } catch (e2) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    } finally {
      client.release();
    }
    return;
  } finally {
    stopRenewal();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockUserForUpdate(client, ctx.userId);

    const st = await client.query(
      `SELECT status FROM searches WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [ctx.searchId, ctx.userId]
    );
    if (!st.rows[0] || st.rows[0].status === 'cancelled') {
      await releaseFreeSearchHold(client, ctx.userId, ctx.holdToken);
      await client.query('COMMIT');
      activeRuns.delete(String(ctx.searchId));
      return;
    }

    if (engineResult.cancelled || engineResult.searchStatus === 'cancelled') {
      await client.query(
        `UPDATE searches SET
           status='cancelled',
           completed_at=NOW(),
           error_summary=$2,
           providers_used = (
             SELECT COALESCE(jsonb_agg(
               CASE
                 WHEN elem->>'status' IN ('pending', 'running')
                   THEN jsonb_set(elem, '{status}', '"cancelled"')
                 ELSE elem
               END
               ORDER BY ord
             ), '[]'::jsonb)
             FROM jsonb_array_elements(providers_used) WITH ORDINALITY AS t(elem, ord)
           )
         WHERE id=$1 AND user_id=$3 AND status='running'`,
        [ctx.searchId, 'cancelled_by_user', ctx.userId]
      );
      await releaseFreeSearchHold(client, ctx.userId, ctx.holdToken);
      await client.query('COMMIT');
      activeRuns.delete(String(ctx.searchId));
      return;
    }

    await client.query(
      `UPDATE searches SET
         status=$2, providers_used=$3::jsonb,
         total_raw=$4, total_normalized=$5, total_after_dedup=$6, total_after_filters=$7,
         error_summary=$8, completed_at=NOW()
       WHERE id=$1 AND user_id=$9 AND status='running'`,
      [
        ctx.searchId, engineResult.searchStatus, JSON.stringify(engineResult._providers || []),
        engineResult.totals.raw, engineResult.totals.normalized, engineResult.totals.afterDedup,
        engineResult.totals.afterFilters,
        engineResult.outcome === 'error' ? 'provider_failure' : null,
        ctx.userId,
      ]
    );

    const inserted = [];
    for (const lead of engineResult.results) {
      const row = await client.query(
        `INSERT INTO search_results (
           search_id,user_id,name,address,phone,email,website,
           rating,reviews_count,category,lat,lng,source_provider,external_id,raw_payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
         RETURNING id,name,address,phone,email,website,rating,reviews_count,category,lat,lng,raw_payload`,
        [
          ctx.searchId, ctx.userId, lead.name, lead.address, lead.phone, lead.email, lead.website,
          lead.rating, lead.reviewsCount, lead.category, lead.lat, lead.lng,
          lead.sourceProvider, lead.externalId,
          JSON.stringify({ ...(lead.raw || {}), photoUrl: lead.photoUrl || null, googleMapsUrl: lead.googleMapsUrl || null, sources: lead.sources || [] }),
        ]
      );
      inserted.push(row.rows[0]);
    }

    const needConsume =
      inserted.length > 0 &&
      (engineResult.outcome === 'results' || engineResult.searchStatus === 'partial');

    if (needConsume) {
      const consumed = await consumeFreeSearchHold(client, ctx.userId, ctx.holdToken);
      if (!consumed) {
        await client.query('ROLLBACK');
        await markSearchFailed(pool, ctx.searchId, ctx.userId, 'hold_lost');
        activeRuns.delete(String(ctx.searchId));
        return;
      }
    } else {
      await releaseFreeSearchHold(client, ctx.userId, ctx.holdToken);
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    try {
      await releaseFreeSearchHold(client, ctx.userId, ctx.holdToken);
      await markSearchFailed(pool, ctx.searchId, ctx.userId, 'persist_failure');
    } catch (_) {}
  } finally {
    client.release();
    activeRuns.delete(String(ctx.searchId));
  }
}

async function cancelSearch(userId, searchId) {
  const pool = getPool();
  const run = activeRuns.get(String(searchId));
  if (run && run.userId === userId) {
    try { run.controller.abort(); } catch (_) {}
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockUserForUpdate(client, userId);
    const st = await client.query(
      `SELECT id, status, filters FROM searches WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [searchId, userId]
    );
    if (!st.rows[0]) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    const status = st.rows[0].status;
    if (status !== 'running') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_running', status };
    }
    await client.query(
      `UPDATE searches SET
         status='cancelled',
         completed_at=NOW(),
         error_summary='cancelled_by_user',
         providers_used = (
           SELECT COALESCE(jsonb_agg(
             CASE
               WHEN elem->>'status' IN ('pending', 'running')
                 THEN jsonb_set(elem, '{status}', '"cancelled"')
               ELSE elem
             END
             ORDER BY ord
           ), '[]'::jsonb)
           FROM jsonb_array_elements(providers_used) WITH ORDINALITY AS t(elem, ord)
         )
       WHERE id=$1 AND user_id=$2 AND status='running'`,
      [searchId, userId]
    );
    const filters = st.rows[0].filters || {};
    const holdToken = filters.holdToken || (run && run.holdToken) || null;
    if (holdToken) {
      try { await releaseFreeSearchHold(client, userId, holdToken); } catch (_) {}
    }
    await client.query('COMMIT');
    activeRuns.delete(String(searchId));
    return { ok: true, status: 'cancelled' };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function getSearchStatus(userId, searchId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, query, location, filters, status, providers_used,
            total_raw, total_normalized, total_after_dedup, total_after_filters,
            error_summary, created_at, started_at, completed_at
     FROM searches WHERE id=$1 AND user_id=$2`,
    [searchId, userId]
  );
  if (!rows[0]) return null;
  const s = rows[0];
  const providers = Array.isArray(s.providers_used) ? s.providers_used : [];
  return {
    searchId: s.id,
    query: s.query,
    location: s.location,
    status: s.status,
    providers,
    totals: {
      raw: s.total_raw,
      normalized: s.total_normalized,
      afterDedup: s.total_after_dedup,
      afterFilters: s.total_after_filters,
      limit: s.filters && s.filters.limit != null ? s.filters.limit : null,
    },
    errorSummary: s.error_summary,
    createdAt: s.created_at,
    startedAt: s.started_at,
    completedAt: s.completed_at,
  };
}

async function runAndPersist(opts) {
  const started = await startSearch(opts);
  for (let i = 0; i < 300; i++) {
    const st = await getSearchStatus(opts.userId, started.searchId);
    if (!st) break;
    if (st.status !== 'running') {
      const data = await getSearchResults(opts.userId, started.searchId);
      return {
        searchId: started.searchId,
        status: st.status,
        outcome: st.status === 'failed' ? 'error' : (data && data.results && data.results.length ? 'results' : 'no_results'),
        message: null,
        hint: null,
        totals: {
          results: data ? data.results.length : 0,
          raw: st.totals.raw,
          normalized: st.totals.normalized,
          afterDedup: st.totals.afterDedup,
          afterFilters: st.totals.afterFilters,
          returned: data ? data.results.length : 0,
        },
        results: data ? data.results : [],
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { searchId: started.searchId, status: 'running', results: [], totals: {} };
}

async function listSearches(userId, { limit = 20, offset = 0 } = {}) {
  const { rows } = await getPool().query(
    `SELECT id, query, location, filters, status, total_after_filters, created_at, completed_at
     FROM searches WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows.map((r) => ({
    id: r.id, query: r.query, location: r.location,
    status: r.status, resultsCount: r.total_after_filters,
    createdAt: r.created_at, completedAt: r.completed_at,
  }));
}

async function getSearchResults(userId, searchId) {
  const pool = getPool();
  const search = await pool.query(
    `SELECT id, query, location, filters, status, total_after_filters, providers_used,
            total_raw, total_normalized, total_after_dedup, created_at
     FROM searches WHERE id=$1 AND user_id=$2`, [searchId, userId]
  );
  if (!search.rows[0]) return null;
  if (search.rows[0].status === 'cancelled') {
    const s = search.rows[0];
    return {
      search: {
        id: s.id, query: s.query, location: s.location,
        status: s.status, resultsCount: 0, createdAt: s.created_at,
      },
      results: [],
      providers: [],
      totals: { raw: 0, afterDedup: 0, afterFilters: 0 },
    };
  }
  const { rows } = await pool.query(
    `SELECT id,name,address,phone,email,website,rating,reviews_count,category,lat,lng,source_provider,external_id,raw_payload
     FROM search_results WHERE search_id=$1 AND user_id=$2 ORDER BY created_at ASC`,
    [searchId, userId]
  );
  const s = search.rows[0];
  return {
    search: {
      id: s.id, query: s.query, location: s.location,
      status: s.status, resultsCount: s.total_after_filters, createdAt: s.created_at,
    },
    results: rows.map(mapPublicRow),
    providers: Array.isArray(s.providers_used) ? s.providers_used : [],
    totals: {
      raw: s.total_raw,
      normalized: s.total_normalized,
      afterDedup: s.total_after_dedup,
      afterFilters: s.total_after_filters,
    },
  };
}

async function dashboardStats(userId) {
  const pool = getPool();
  const [searches, results, leads] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM searches WHERE user_id=$1', [userId]),
    pool.query('SELECT COUNT(*)::int AS c FROM search_results WHERE user_id=$1', [userId]),
    pool.query('SELECT COUNT(*)::int AS c FROM saved_leads WHERE user_id=$1', [userId]),
  ]);
  return {
    searchesCount: searches.rows[0].c,
    resultsCount: results.rows[0].c,
    savedLeadsCount: leads.rows[0].c,
    recentSearches: await listSearches(userId, { limit: 5 }),
  };
}

async function listSavedLeads(userId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await getPool().query(
    `SELECT id,name,address,phone,email,website,rating,reviews_count,category,lat,lng,notes,created_at
     FROM saved_leads WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, address: r.address, phone: r.phone, email: r.email, website: r.website,
    rating: r.rating != null ? Number(r.rating) : null, reviewsCount: r.reviews_count,
    category: r.category, lat: r.lat, lng: r.lng, notes: r.notes, createdAt: r.created_at,
  }));
}

async function saveLeadsFromResults(userId, resultIds) {
  const pool = getPool();
  const client = await pool.connect();
  const saved = [];
  const alreadySaved = [];
  try {
    await client.query('BEGIN');
    await lockUserForUpdate(client, userId);

    const ids = Array.from(new Set((resultIds || []).filter(Boolean))).slice(0, 100);
    for (const rid of ids) {
      const { rows } = await client.query(
        `SELECT id, search_id, name, address, phone, email, website, rating, reviews_count,
                category, lat, lng, source_provider, external_id, raw_payload
         FROM search_results WHERE id=$1 AND user_id=$2`,
        [rid, userId]
      );
      if (!rows[0]) continue;
      const r = rows[0];
      const identity = leadIdentityKey({
        name: r.name, address: r.address, phone: r.phone,
      });
      const identityKey = identity || (
        r.source_provider && r.external_id
          ? ('x:' + r.source_provider + ':' + String(r.external_id).slice(0, 80))
          : null
      );

      if (identityKey) {
        const existing = await client.query(
          `SELECT id, name, address, phone, email, website, created_at
           FROM saved_leads
           WHERE user_id=$1 AND identity_key=$2
           LIMIT 1`,
          [userId, identityKey]
        );
        if (existing.rows[0]) {
          alreadySaved.push({
            id: existing.rows[0].id,
            name: existing.rows[0].name,
            address: existing.rows[0].address,
            phone: existing.rows[0].phone,
            email: existing.rows[0].email,
            website: existing.rows[0].website,
            createdAt: existing.rows[0].created_at,
          });
          continue;
        }
      }

      try {
        const ins = await client.query(
          `INSERT INTO saved_leads (
             user_id, origin_search_id, origin_result_id,
             name, address, phone, email, website, rating, reviews_count, category, lat, lng,
             source_provider, external_id, identity_key, snapshot
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
           RETURNING id, name, address, phone, email, website, created_at`,
          [
            userId, r.search_id, r.id,
            r.name, r.address, r.phone, r.email, r.website, r.rating, r.reviews_count,
            r.category, r.lat, r.lng, r.source_provider, r.external_id, identityKey,
            JSON.stringify({ source: 'search_result', resultId: r.id }),
          ]
        );
        saved.push(ins.rows[0]);
      } catch (err) {
        if (err && (err.code === '23505' || /unique/i.test(String(err.message || '')))) {
          alreadySaved.push({
            id: null, name: r.name, address: r.address, phone: r.phone,
            email: r.email, website: r.website, createdAt: null,
          });
          continue;
        }
        throw err;
      }
    }
    await client.query('COMMIT');
    return {
      savedCount: saved.length,
      alreadySavedCount: alreadySaved.length,
      saved: saved.map((s) => ({
        id: s.id, name: s.name, address: s.address, phone: s.phone,
        email: s.email, website: s.website, createdAt: s.created_at,
      })),
      alreadySaved,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  startSearch,
  cancelSearch,
  getSearchStatus,
  runAndPersist,
  listSearches,
  getSearchResults,
  dashboardStats,
  listSavedLeads,
  saveLeadsFromResults,
  recoverAbandonedSearches,
  FREE_SEARCH_HOLD_MINUTES,
  activeRuns,
  markPendingProvidersCancelled,
};
