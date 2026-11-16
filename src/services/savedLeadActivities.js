'use strict';
/**
 * CRM Stage 2 — activity history for saved leads.
 * Manual activities + automatic status_change events (written by updateSavedLead).
 */
function getPool() {
  return require('../db/pool').getPool();
}

const ACTIVITY_TYPES = Object.freeze([
  'phone_call',
  'whatsapp',
  'meeting',
  'other',
  'status_change',
]);

const MANUAL_ACTIVITY_TYPES = Object.freeze([
  'phone_call',
  'whatsapp',
  'meeting',
  'other',
]);

const DESCRIPTION_MAX = 5000;
const OUTCOME_MAX = 2000;

function isValidManualActivityType(type) {
  return MANUAL_ACTIVITY_TYPES.includes(type);
}

function isValidActivityType(type) {
  return ACTIVITY_TYPES.includes(type);
}

function mapActivityRow(r) {
  return {
    id: r.id,
    leadId: r.lead_id,
    activityType: r.activity_type,
    description: r.description,
    outcome: r.outcome != null ? r.outcome : null,
    occurredAt: r.occurred_at,
    fromStatus: r.from_status != null ? r.from_status : null,
    toStatus: r.to_status != null ? r.to_status : null,
    createdAt: r.created_at,
  };
}

/**
 * List activities for a lead owned by userId (newest first).
 */
async function listActivities(userId, leadId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  const pool = getPool();

  const own = await pool.query(
    `SELECT id FROM saved_leads WHERE id = $1 AND user_id = $2`,
    [leadId, userId]
  );
  if (!own.rows[0]) return null;

  const { rows } = await pool.query(
    `SELECT id, lead_id, activity_type, description, outcome, occurred_at,
            from_status, to_status, created_at
     FROM saved_lead_activities
     WHERE user_id = $1 AND lead_id = $2
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT $3 OFFSET $4`,
    [userId, leadId, limit, offset]
  );

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM saved_lead_activities
     WHERE user_id = $1 AND lead_id = $2`,
    [userId, leadId]
  );

  return {
    items: rows.map(mapActivityRow),
    total: countRes.rows[0] ? countRes.rows[0].total : 0,
    limit,
    offset,
  };
}

/**
 * Create a manual activity. Does not accept status_change (backend-only).
 */
async function createActivity(userId, leadId, input) {
  const type = input && input.activityType != null ? String(input.activityType).trim() : '';
  if (!isValidManualActivityType(type)) {
    const err = new Error('Tipo de actividade inválido.');
    err.code = 'VALIDATION';
    throw err;
  }

  let description = input && input.description != null ? String(input.description).trim() : '';
  if (!description) {
    const err = new Error('A descrição é obrigatória.');
    err.code = 'VALIDATION';
    throw err;
  }
  if (description.length > DESCRIPTION_MAX) {
    const err = new Error(`A descrição não pode ultrapassar ${DESCRIPTION_MAX} caracteres.`);
    err.code = 'VALIDATION';
    throw err;
  }

  let outcome = null;
  if (input && input.outcome != null && String(input.outcome).trim() !== '') {
    outcome = String(input.outcome).trim();
    if (outcome.length > OUTCOME_MAX) {
      const err = new Error(`O resultado não pode ultrapassar ${OUTCOME_MAX} caracteres.`);
      err.code = 'VALIDATION';
      throw err;
    }
  }

  let occurredAt;
  if (input && input.occurredAt != null && String(input.occurredAt).trim() !== '') {
    const d = new Date(input.occurredAt);
    if (Number.isNaN(d.getTime())) {
      const err = new Error('Data/hora da actividade inválida.');
      err.code = 'VALIDATION';
      throw err;
    }
    occurredAt = d.toISOString();
  } else {
    occurredAt = new Date().toISOString();
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const own = await client.query(
      `SELECT id FROM saved_leads WHERE id = $1 AND user_id = $2 FOR SHARE`,
      [leadId, userId]
    );
    if (!own.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const ins = await client.query(
      `INSERT INTO saved_lead_activities (
         user_id, lead_id, activity_type, description, outcome, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
       RETURNING id, lead_id, activity_type, description, outcome, occurred_at,
                 from_status, to_status, created_at`,
      [userId, leadId, type, description, outcome, occurredAt]
    );

    await client.query('COMMIT');
    return mapActivityRow(ins.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Insert a status_change activity inside an existing transaction client.
 * Used by updateSavedLead — caller owns BEGIN/COMMIT.
 */
async function insertStatusChangeActivity(client, userId, leadId, fromStatus, toStatus, occurredAt) {
  const description = `${fromStatus} → ${toStatus}`;
  const { rows } = await client.query(
    `INSERT INTO saved_lead_activities (
       user_id, lead_id, activity_type, description, outcome, occurred_at, from_status, to_status
     ) VALUES ($1, $2, 'status_change', $3, NULL, $4::timestamptz, $5, $6)
     RETURNING id, lead_id, activity_type, description, outcome, occurred_at,
               from_status, to_status, created_at`,
    [userId, leadId, description, occurredAt || new Date().toISOString(), fromStatus, toStatus]
  );
  return mapActivityRow(rows[0]);
}

/**
 * Insert a manual "other" activity using an existing transactional client.
 * Throws on failure — caller must ROLLBACK. Does not open its own connection.
 */
async function insertOtherActivity(client, userId, leadId, description, occurredAt) {
  const desc = description != null ? String(description).trim() : '';
  if (!desc) {
    const err = new Error('A descrição da actividade é obrigatória.');
    err.code = 'VALIDATION';
    throw err;
  }
  if (desc.length > DESCRIPTION_MAX) {
    const err = new Error(`A descrição não pode ultrapassar ${DESCRIPTION_MAX} caracteres.`);
    err.code = 'VALIDATION';
    throw err;
  }
  const { rows } = await client.query(
    `INSERT INTO saved_lead_activities (
       user_id, lead_id, activity_type, description, outcome, occurred_at
     ) VALUES ($1, $2, 'other', $3, NULL, $4::timestamptz)
     RETURNING id, lead_id, activity_type, description, outcome, occurred_at,
               from_status, to_status, created_at`,
    [userId, leadId, desc, occurredAt || new Date().toISOString()]
  );
  return mapActivityRow(rows[0]);
}

/**
 * Delete one activity owned by user for the given lead.
 */
async function deleteActivity(userId, leadId, activityId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `DELETE FROM saved_lead_activities
     WHERE id = $1 AND lead_id = $2 AND user_id = $3
     RETURNING id`,
    [activityId, leadId, userId]
  );
  return rows[0] ? { deleted: true, id: rows[0].id } : { deleted: false };
}

/**
 * Delete all activities for a lead owned by user.
 */
async function clearActivities(userId, leadId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Ensure lead belongs to user
    const lead = await client.query(
      `SELECT id FROM saved_leads WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [leadId, userId]
    );
    if (!lead.rows[0]) {
      await client.query('ROLLBACK');
      const err = new Error('Lead não encontrado.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const { rows } = await client.query(
      `DELETE FROM saved_lead_activities WHERE lead_id = $1 AND user_id = $2 RETURNING id`,
      [leadId, userId]
    );
    await client.query('COMMIT');
    return { deletedCount: rows.length };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ACTIVITY_TYPES,
  MANUAL_ACTIVITY_TYPES,
  DESCRIPTION_MAX,
  OUTCOME_MAX,
  isValidManualActivityType,
  isValidActivityType,
  listActivities,
  createActivity,
  insertStatusChangeActivity,
  insertOtherActivity,
  mapActivityRow,
  deleteActivity,
  clearActivities,
};
