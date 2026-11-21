'use strict';
/**
 * CRM Stage 1 — saved leads listing, detail and status/notes updates.
 */
function getPool() {
  return require('../db/pool').getPool();
}

const CRM_STATUSES = Object.freeze([
  'Por contactar',
  'Contactado',
  'Não atendeu',
  'Aguardando resposta',
  'Interessado',
  'Reunião agendada',
  'Não interessado',
  'Cliente',
]);

const CRM_NOTES_MAX = 10000;

const CRM_SORT = Object.freeze({
  recent: 'created_at DESC',
  oldest: 'created_at ASC',
  name_asc: "LOWER(COALESCE(name, '')) ASC",
  name_desc: "LOWER(COALESCE(name, '')) DESC",
});

function mapSavedLeadRow(r) {
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    phone: r.phone,
    email: r.email,
    website: r.website,
    rating: r.rating != null ? Number(r.rating) : null,
    reviewsCount: r.reviews_count,
    category: r.category,
    lat: r.lat,
    lng: r.lng,
    notes: r.notes,
    status: r.status || 'Por contactar',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function isValidCrmStatus(status) {
  return CRM_STATUSES.includes(status);
}

async function listSavedLeads(userId, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 20, 1), 100);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  const q = opts.q != null ? String(opts.q).trim() : '';
  const status = opts.status != null ? String(opts.status).trim() : '';
  const category = opts.category != null ? String(opts.category).trim() : '';
  const sortKey = opts.sort && CRM_SORT[opts.sort] ? opts.sort : 'recent';
  const orderSql = CRM_SORT[sortKey];

  const pool = getPool();
  const where = ['user_id = $1'];
  const params = [userId];
  let p = 2;

  if (q) {
    where.push(`(name ILIKE $${p} OR phone ILIKE $${p})`);
    params.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%');
    p += 1;
  }
  if (status && isValidCrmStatus(status)) {
    where.push(`status = $${p}`);
    params.push(status);
    p += 1;
  }
  if (category) {
    where.push(`category = $${p}`);
    params.push(category);
    p += 1;
  }

  const whereSql = where.join(' AND ');

  const listParams = params.concat([limit, offset]);
  const [countRes, listRes, countsRes, catRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total FROM saved_leads WHERE ${whereSql}`,
      params
    ),
    pool.query(
      `SELECT id, name, address, phone, email, website, rating, reviews_count, category,
              lat, lng, notes, status, created_at, updated_at
       FROM saved_leads
       WHERE ${whereSql}
       ORDER BY ${orderSql}
       LIMIT $${p} OFFSET $${p + 1}`,
      listParams
    ),
    pool.query(
      `SELECT status, COUNT(*)::int AS c
       FROM saved_leads
       WHERE user_id = $1
       GROUP BY status`,
      [userId]
    ),
    pool.query(
      `SELECT DISTINCT category
       FROM saved_leads
       WHERE user_id = $1 AND category IS NOT NULL AND btrim(category) <> ''
       ORDER BY category ASC`,
      [userId]
    ),
  ]);

  const total = countRes.rows[0] ? countRes.rows[0].total : 0;
  const rows = listRes.rows;
  const statusCounts = {};
  for (const s of CRM_STATUSES) statusCounts[s] = 0;
  let totalLeads = 0;
  for (const row of countsRes.rows) {
    const st = row.status || 'Por contactar';
    statusCounts[st] = row.c;
    totalLeads += row.c;
  }
  const categories = catRes.rows.map((r) => r.category);

  return {
    items: rows.map(mapSavedLeadRow),
    total,
    limit,
    offset,
    statusCounts,
    totalLeads,
    categories,
  };
}

async function getSavedLead(userId, leadId) {
  const { rows } = await getPool().query(
    `SELECT id, name, address, phone, email, website, rating, reviews_count, category,
            lat, lng, notes, status, created_at, updated_at
     FROM saved_leads WHERE id = $1 AND user_id = $2`,
    [leadId, userId]
  );
  if (!rows[0]) return null;
  return mapSavedLeadRow(rows[0]);
}

async function updateSavedLead(userId, leadId, patch) {
  const updates = [];
  const params = [];
  let p = 1;
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'status')) {
    if (!isValidCrmStatus(patch.status)) {
      const err = new Error('Estado CRM inválido.');
      err.code = 'VALIDATION';
      throw err;
    }
    updates.push(`status = $${p++}`);
    params.push(patch.status);
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'notes')) {
    let notes = patch.notes;
    if (notes != null) notes = String(notes);
    if (notes != null && notes.length > CRM_NOTES_MAX) {
      const err = new Error(`Notas não podem ultrapassar ${CRM_NOTES_MAX} caracteres.`);
      err.code = 'VALIDATION';
      throw err;
    }
    updates.push(`notes = $${p++}`);
    params.push(notes);
  }
  if (!updates.length) {
    return getSavedLead(userId, leadId);
  }
  updates.push('updated_at = NOW()');
  params.push(leadId, userId);
  const { rows } = await getPool().query(
    `UPDATE saved_leads SET ${updates.join(', ')}
     WHERE id = $${p} AND user_id = $${p + 1}
     RETURNING id, name, address, phone, email, website, rating, reviews_count, category,
               lat, lng, notes, status, created_at, updated_at`,
    params
  );
  if (!rows[0]) return null;
  return mapSavedLeadRow(rows[0]);
}

module.exports = {
  CRM_STATUSES,
  CRM_NOTES_MAX,
  isValidCrmStatus,
  listSavedLeads,
  getSavedLead,
  updateSavedLead,
};
