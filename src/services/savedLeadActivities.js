'use strict';
/**
 * CRM Stage 2 — activity history for saved leads.
 * Manual activities + automatic status_change rows.
 */
function getPool() {
  return require('../db/pool').getPool();
}

const MANUAL_ACTIVITY_TYPES = Object.freeze([
  'call', 'email', 'meeting', 'whatsapp', 'note', 'other',
]);
const ACTIVITY_TYPES = Object.freeze([...MANUAL_ACTIVITY_TYPES, 'status_change']);
const DESCRIPTION_MAX = 5000;

function isValidActivityType(type) {
  return ACTIVITY_TYPES.includes(type);
}
function isValidManualActivityType(type) {
  return MANUAL_ACTIVITY_TYPES.includes(type);
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

async function listActivities(userId, leadId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  const pool = getPool();

  const own = await pool.query(
    `SELECT id FROM saved_leads WHERE id = $1 AND user_id = $2`,
    [leadId, userId]
  );
  if (!own.rows[0]) return null;

  const where = ['user_id = $1', 'lead_id = $2'];
  const params = [userId, leadId];
  let p = 3;

  const activityType = opts.activityType != null ? String(opts.activityType).trim() : '';
  if (activityType && isValidActivityType(activityType)) {
    where.push(`activity_type = $${p}`);
    params.push(activityType);
    p += 1;
  }

  const q = opts.q != null ? String(opts.q).trim() : '';
  if (q) {
    where.push(`(description ILIKE $${p} OR COALESCE(outcome, '') ILIKE $${p})`);
    params.push('%' + q.replace(/[%_]/g, '\\$&') + '%');
    p += 1;
  }

  const whereSql = where.join(' AND ');

  const listParams = params.concat([limit, offset]);
  const [listRes, countRes] = await Promise.all([
    pool.query(
      `SELECT id, lead_id, activity_type, description, outcome, occurred_at,
              from_status, to_status, created_at
       FROM saved_lead_activities
       WHERE ${whereSql}
       ORDER BY occurred_at DESC, created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      listParams
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM saved_lead_activities
       WHERE ${whereSql}`,
      params
    ),
  ]);

  return {
    items: listRes.rows.map(mapActivityRow),
    total: countRes.rows[0] ? countRes.rows[0].total : 0,
    limit,
    offset,
  };
}
