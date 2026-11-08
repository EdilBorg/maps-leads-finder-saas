/**
 * Persist searches / results / leads with multi-tenant isolation.
 * Free-search: atomic hold + validated consume in the same TX as result inserts.
 */
const { getPool } = require('../db/pool');
const {
  executeSearch,
  publicLead,
  clientMessageForOutcome,
  clientHintForOutcome,
} = require('./searchEngine');
const {
  acquireFreeSearchHold,
  bindHoldToSearch,
  renewFreeSearchHold,
  consumeFreeSearchHold,
  releaseFreeSearchHold,
  recoverAbandonedSearches,
  FREE_SEARCH_HOLD_MINUTES,
  FREE_SEARCH_RENEW_INTERVAL_MS,
} = require('./freeSearchHold');

const RETENTION_DAYS = 30;

function mapPublicRow(r, i) {
  return publicLead({
    id: r.id, name: r.name, address: r.address, phone: r.phone, email: r.email, website: r.website,
    rating: r.rating != null ? Number(r.rating) : null, reviewsCount: r.reviews_count,
    category: r.category, lat: r.lat, lng: r.lng,
  }, i);
}

function startHoldRenewal(userId, holdToken) {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || !holdToken) return;
    getPool().connect().then(async (client) => {
      try {
        const r = await renewFreeSearchHold(client, userId, holdToken);
        if (!r.renewed) { stopped = true; clearInterval(timer); }
      } finally { client.release(); }
    }).catch(() => {});
  }, FREE_SEARCH_RENEW_INTERVAL_MS);
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

async function runAndPersist(opts) {
  const pool = getPool();
  let searchId = null;
  let holdToken = null;
  let stopRenewal = null;

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
      const ins = await client.query(
        `INSERT INTO searches (
           user_id, query, location, filters, status, providers_used, started_at, expires_at
         ) VALUES ($1,$2,$3,$4::jsonb,'running',$5::jsonb,NOW(), NOW() + ($6 || ' days')::interval)
         RETURNING id`,
        [
          opts.userId, opts.query, opts.location,
          JSON.stringify({
            modality: opts.modality === 'expanded' ? 'expanded' : 'standard',
            ...(opts.filters || {}),
            limit: opts.limit || 100,
            holdToken,
          }),
          JSON.stringify([]),
          String(RETENTION_DAYS),
        ]
      );
      searchId = ins.rows[0].id;
      await bindHoldToSearch(client, opts.userId, holdToken, searchId);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (holdToken && err.code !== 'QUOTA') {
        try { await releaseFreeSearchHold(client, opts.userId, holdToken); } catch (_) {}
      }
      client.release();
      throw err;
    }
    client.release();
  }

  stopRenewal = startHoldRenewal(opts.userId, holdToken);
  let engineResult;
  try {
    engineResult = await executeSearch({
      modality: opts.modality, query: opts.query, location: opts.location,
      filters: opts.filters, limit: opts.limit, providers: opts.providers,
    });
  } catch (err) {
    if (stopRenewal) stopRenewal();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE searches SET status='failed', completed_at=NOW(), error_summary=$2 WHERE id=$1 AND user_id=$3`,
        [searchId, err.message || 'engine error', opts.userId]
      );
      await releaseFreeSearchHold(client, opts.userId, holdToken);
      await client.query('COMMIT');
    } catch (e2) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e2;
    } finally { client.release(); }
    throw err;
  } finally {
    if (stopRenewal) stopRenewal();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE searches SET
         status=$2, providers_used=$3::jsonb,
         total_raw=$4, total_normalized=$5, total_after_dedup=$6, total_after_filters=$7,
         error_summary=$8, completed_at=NOW()
       WHERE id=$1 AND user_id=$9`,
      [
        searchId, engineResult.searchStatus, JSON.stringify(engineResult._providers || []),
        engineResult.totals.raw, engineResult.totals.normalized, engineResult.totals.afterDedup,
        engineResult.totals.afterFilters,
        engineResult.outcome === 'error' ? 'provider_failure' : null,
        opts.userId,
      ]
    );

    const inserted = [];
    for (const lead of engineResult.results) {
      const row = await client.query(
        `INSERT INTO search_results (
           search_id,user_id,name,address,phone,email,website,
           rating,reviews_count,category,lat,lng,source_provider,external_id,raw_payload
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
         RETURNING id,name,address,phone,email,website,rating,reviews_count,category,lat,lng`,
        [
          searchId, opts.userId, lead.name, lead.address, lead.phone, lead.email, lead.website,
          lead.rating, lead.reviewsCount, lead.category, lead.lat, lead.lng,
          lead.sourceProvider, lead.externalId, JSON.stringify(lead.raw || {}),
        ]
      );
      inserted.push(row.rows[0]);
    }

    const needConsume =
      inserted.length > 0 &&
      (engineResult.outcome === 'results' || engineResult.searchStatus === 'partial');

    if (needConsume) {
      const consumed = await consumeFreeSearchHold(client, opts.userId, holdToken);
      if (!consumed) {
        await client.query('ROLLBACK');
        await markSearchFailed(pool, searchId, opts.userId, 'hold_lost');
        const err = new Error('A reserva da pesquisa gratuita expirou ou foi substituída. Tenta novamente.');
        err.code = 'QUOTA_HOLD_LOST';
        throw err;
      }
    } else {
      await releaseFreeSearchHold(client, opts.userId, holdToken);
    }

    await client.query('COMMIT');
    return {
      searchId,
      status: engineResult.searchStatus,
      outcome: engineResult.outcome,
      message: clientMessageForOutcome(engineResult.outcome),
      hint: clientHintForOutcome(engineResult.outcome),
      totals: {
        results: inserted.length,
        raw: engineResult.totals.raw,
        normalized: engineResult.totals.normalized,
        afterDedup: engineResult.totals.afterDedup,
        afterFilters: engineResult.totals.afterFilters,
        returned: engineResult.totals.returned,
      },
      results: inserted.map(mapPublicRow),
    };
  } catch (err) {
    if (err.code !== 'QUOTA_HOLD_LOST') {
      try { await client.query('ROLLBACK'); } catch (_) {}
      try {
        await releaseFreeSearchHold(client, opts.userId, holdToken);
        await markSearchFailed(pool, searchId, opts.userId, 'persist_failure');
      } catch (_) {}
    }
    throw err;
  } finally {
    client.release();
  }
}

async function listSearches(userId, { limit = 20, offset = 0 } = {}) {
  const { rows } = await getPool().query(
    `SELECT id, query, location, filters, status, total_after_filters, created_at, completed_at
     FROM searches WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return rows.map((r) => ({
    id: r.id, query: r.query, location: r.location,
    modality: r.filters && r.filters.modality === 'expanded' ? 'expanded' : 'standard',
    status: r.status, resultsCount: r.total_after_filters,
    createdAt: r.created_at, completedAt: r.completed_at,
  }));
}

async function getSearchResults(userId, searchId) {
  const pool = getPool();
  const search = await pool.query(
    `SELECT id, query, location, filters, status, total_after_filters, created_at
     FROM searches WHERE id=$1 AND user_id=$2`, [searchId, userId]
  );
  if (!search.rows[0]) return null;
  const { rows } = await pool.query(
    `SELECT id,name,address,phone,email,website,rating,reviews_count,category,lat,lng
     FROM search_results WHERE search_id=$1 AND user_id=$2 ORDER BY created_at ASC`,
    [searchId, userId]
  );
  const s = search.rows[0];
  return {
    search: {
      id: s.id, query: s.query, location: s.location,
      modality: s.filters && s.filters.modality === 'expanded' ? 'expanded' : 'standard',
      status: s.status, resultsCount: s.total_after_filters, createdAt: s.created_at,
    },
    results: rows.map(mapPublicRow),
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
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const saved = [];
    for (const rid of resultIds) {
      const { rows } = await client.query(
        'SELECT * FROM search_results WHERE id=$1 AND user_id=$2', [rid, userId]
      );
      if (!rows[0]) continue;
      const r = rows[0];
      const ins = await client.query(
        `INSERT INTO saved_leads (
           user_id,origin_search_id,origin_result_id,name,address,phone,email,website,
           rating,reviews_count,category,lat,lng,source_provider,external_id,snapshot
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
         RETURNING id,name,address,phone,email,website,created_at`,
        [
          userId, r.search_id, r.id, r.name, r.address, r.phone, r.email, r.website,
          r.rating, r.reviews_count, r.category, r.lat, r.lng, r.source_provider,
          r.external_id, JSON.stringify(r),
        ]
      );
      saved.push(ins.rows[0]);
    }
    await client.query('COMMIT');
    return saved;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runAndPersist, listSearches, getSearchResults, dashboardStats,
  listSavedLeads, saveLeadsFromResults, recoverAbandonedSearches, FREE_SEARCH_HOLD_MINUTES,
};
