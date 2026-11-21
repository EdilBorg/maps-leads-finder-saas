'use strict';
/**
 * Commercial delivered-leads quota (2.500 per subscription period).
 * Separate from provider financial reserves (Apify / Bright Data / TomTom).
 */

function getPool() {
  return require('../db/pool').getPool();
}

const { lockUserForUpdate } = require('./freeSearchHold');

/**
 * Sum delivered leads in period (total_after_filters on completed/partial).
 */
async function sumDeliveredInPeriod(client, userId, periodStart, periodEnd) {
  // Commercial Pro quota counts only paid searches (filters.quotaMode = 'paid').
  // Trial/free searches must never consume the 2.500-lead plan budget.
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(total_after_filters), 0)::int AS delivered
     FROM searches
     WHERE user_id = $1
       AND status IN ('completed', 'partial')
       AND completed_at IS NOT NULL
       AND completed_at >= $2
       AND completed_at < $3
       AND COALESCE(filters->>'quotaMode', '') = 'paid'`,
    [userId, periodStart, periodEnd]
  );
  return rows[0] ? Number(rows[0].delivered) || 0 : 0;
}

/**
 * Sum active holds (reserved - committed for status held; only reserved for held).
 */
async function sumActiveReserved(client, userId, periodStart) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(reserved_count - committed_count), 0)::int AS reserved
     FROM lead_quota_holds
     WHERE user_id = $1
       AND period_start = $2
       AND status = 'held'`,
    [userId, periodStart]
  );
  return rows[0] ? Number(rows[0].reserved) || 0 : 0;
}

/**
 * Reserve commercial capacity for a paid search.
 * Must run inside an open transaction with user row locked.
 * @returns {{ ok, reserved, available, planLimit, effectiveLimit, holdId }}
 */
async function reserveLeadQuota(client, {
  userId,
  searchId,
  requestedLimit,
  planLimit,
  periodStart,
  periodEnd,
  idempotencyKey,
}) {
  if (!searchId || !userId) {
    return { ok: false, reason: 'MISSING_IDS', message: 'Identificadores em falta para reserva de quota.' };
  }
  if (planLimit == null || planLimit <= 0) {
    return { ok: false, reason: 'NO_PLAN_LIMIT', message: 'Plano sem quota de leads definida.' };
  }

  const existing = await client.query(
    `SELECT * FROM lead_quota_holds WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return {
      ok: true,
      replayed: true,
      reserved: row.reserved_count,
      effectiveLimit: row.reserved_count,
      planLimit,
      holdId: row.id,
      available: null,
    };
  }

  const delivered = await sumDeliveredInPeriod(client, userId, periodStart, periodEnd);
  const reserved = await sumActiveReserved(client, userId, periodStart);
  const available = Math.max(0, planLimit - delivered - reserved);

  if (available <= 0) {
    return {
      ok: false,
      reason: 'QUOTA_EXHAUSTED',
      message: 'A quota de 2.500 leads deste ciclo foi esgotada.',
      available: 0,
      delivered,
      reserved,
      planLimit,
    };
  }

  const want = Math.max(1, Math.min(Number(requestedLimit) || 0, 500));
  const effectiveLimit = Math.min(want, available);

  const ins = await client.query(
    `INSERT INTO lead_quota_holds (
       user_id, search_id, period_start, period_end,
       reserved_count, committed_count, status, idempotency_key
     ) VALUES ($1,$2,$3,$4,$5,0,'held',$6)
     RETURNING id, reserved_count`,
    [userId, searchId, periodStart, periodEnd, effectiveLimit, idempotencyKey]
  );

  return {
    ok: true,
    replayed: false,
    reserved: ins.rows[0].reserved_count,
    effectiveLimit: ins.rows[0].reserved_count,
    planLimit,
    holdId: ins.rows[0].id,
    available: available - ins.rows[0].reserved_count,
    delivered,
    previouslyReserved: reserved,
  };
}

/**
 * Confirm delivered leads and release unused reservation.
 * Idempotent by search_id.
 */
async function commitLeadQuota(client, { userId, searchId, deliveredCount }) {
  const { rows } = await client.query(
    `SELECT * FROM lead_quota_holds WHERE search_id = $1 AND user_id = $2 FOR UPDATE`,
    [searchId, userId]
  );
  if (!rows[0]) {
    // No hold: only OK if nothing was delivered
    const n = Math.max(0, Number(deliveredCount) || 0);
    if (n > 0) {
      const err = new Error('Quota comercial: leads entregues sem reserva activa.');
      err.code = 'LEAD_QUOTA_MISSING_HOLD';
      throw err;
    }
    return { ok: true, skipped: true };
  }
  const row = rows[0];
  if (row.status === 'committed') {
    // Idempotent replay: delivered must not exceed prior commit
    const n = Math.max(0, Number(deliveredCount) || 0);
    if (n !== Number(row.committed_count)) {
      const err = new Error('Quota comercial: reconfirmação inconsistente com o consumo já registado.');
      err.code = 'LEAD_QUOTA_IDEMPOTENCY_MISMATCH';
      throw err;
    }
    return { ok: true, replayed: true, committed: row.committed_count, status: row.status };
  }
  if (row.status !== 'held') {
    const err = new Error('Quota comercial: reserva num estado inválido para confirmação.');
    err.code = 'LEAD_QUOTA_INVALID_STATE';
    throw err;
  }
  const n = Math.max(0, Number(deliveredCount) || 0);
  if (n > Number(row.reserved_count)) {
    const err = new Error(
      'Quota comercial: tentou confirmar ' + n + ' leads com reserva de apenas ' + row.reserved_count + '.'
    );
    err.code = 'LEAD_QUOTA_OVER_DELIVERY';
    throw err;
  }
  await client.query(
    `UPDATE lead_quota_holds
     SET committed_count = $1, status = 'committed', updated_at = NOW()
     WHERE id = $2`,
    [n, row.id]
  );
  return { ok: true, committed: n, released: row.reserved_count - n };
}

/**
 * Release hold without committing (cancel / fail / no results).
 */
async function releaseLeadQuota(client, { userId, searchId }) {
  const { rows } = await client.query(
    `SELECT * FROM lead_quota_holds WHERE search_id = $1 AND user_id = $2 FOR UPDATE`,
    [searchId, userId]
  );
  if (!rows[0]) return { ok: true, skipped: true };
  if (rows[0].status !== 'held') return { ok: true, replayed: true, status: rows[0].status };
  await client.query(
    `UPDATE lead_quota_holds
     SET status = 'released', committed_count = 0, updated_at = NOW()
     WHERE id = $1`,
    [rows[0].id]
  );
  return { ok: true, released: rows[0].reserved_count };
}

async function getReservedForUser(userId, periodStart) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(reserved_count - committed_count), 0)::int AS reserved
     FROM lead_quota_holds
     WHERE user_id = $1 AND period_start = $2 AND status = 'held'`,
    [userId, periodStart]
  );
  return rows[0] ? Number(rows[0].reserved) || 0 : 0;
}


/**
 * Release lead quota outside a caller transaction.
 * Logs failures with context; never claims success when release did not complete.
 * @returns {{ ok: boolean, released?: number, skipped?: boolean, error?: Error }}
 */
async function releaseLeadQuotaSafe({ userId, searchId, reason = 'unspecified' }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await releaseLeadQuota(client, { userId, searchId });
    await client.query('COMMIT');
    return { ok: true, ...result };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[lead-quota-release-failed]', {
      userId, searchId, reason,
      message: err && err.message,
      code: err && err.code,
    });
    return { ok: false, error: err };
  } finally {
    client.release();
  }
}

/**
 * Release held commercial quotas for searches that are no longer running.
 * Safe to call repeatedly (idempotent per hold row).
 */
async function recoverOrphanedLeadHolds({ limit = 100 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT h.id, h.user_id, h.search_id, h.status AS hold_status, s.status AS search_status
     FROM lead_quota_holds h
     JOIN searches s ON s.id = h.search_id
     WHERE h.status = 'held'
       AND s.status NOT IN ('running', 'pending')
     ORDER BY h.created_at ASC
     LIMIT $1`,
    [limit]
  );
  const results = [];
  for (const row of rows) {
    const r = await releaseLeadQuotaSafe({
      userId: row.user_id,
      searchId: row.search_id,
      reason: 'orphan_recovery:' + (row.search_status || 'unknown'),
    });
    results.push({ searchId: row.search_id, ...r });
  }
  return results;
}

module.exports = {
  reserveLeadQuota,
  commitLeadQuota,
  releaseLeadQuota,
  releaseLeadQuotaSafe,
  recoverOrphanedLeadHolds,
  sumDeliveredInPeriod,
  sumActiveReserved,
  getReservedForUser,
};
