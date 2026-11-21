'use strict';
/**
 * CRM Stage 2 — per-lead appointments (independent of commercial lead status).
 * Prepared for Phase 3 global agenda queries (indexes by user_id + scheduled_at).
 */
function getPool() {
  return require('../db/pool').getPool();
}

const APPOINTMENT_STATUSES = Object.freeze(['scheduled', 'completed', 'cancelled']);
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 5000;

function isValidAppointmentStatus(status) {
  return APPOINTMENT_STATUSES.includes(status);
}

function mapAppointmentRow(r) {
  return {
    id: r.id,
    leadId: r.lead_id,
    title: r.title,
    description: r.description != null ? r.description : null,
    scheduledAt: r.scheduled_at,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function validateTitle(title) {
  const t = title != null ? String(title).trim() : '';
  if (!t) {
    const err = new Error('O título é obrigatório.');
    err.code = 'VALIDATION';
    throw err;
  }
  if (t.length > TITLE_MAX) {
    const err = new Error(`O título não pode ultrapassar ${TITLE_MAX} caracteres.`);
    err.code = 'VALIDATION';
    throw err;
  }
  return t;
}

function validateDescription(description) {
  if (description == null || String(description).trim() === '') return null;
  const d = String(description).trim();
  if (d.length > DESCRIPTION_MAX) {
    const err = new Error(`A descrição não pode ultrapassar ${DESCRIPTION_MAX} caracteres.`);
    err.code = 'VALIDATION';
    throw err;
  }
  return d;
}

function parseScheduledAt(value) {
  if (value == null || String(value).trim() === '') {
    const err = new Error('Data e hora são obrigatórias.');
    err.code = 'VALIDATION';
    throw err;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    const err = new Error('Data/hora do compromisso inválida.');
    err.code = 'VALIDATION';
    throw err;
  }
  return d.toISOString();
}

async function assertLeadOwned(clientOrPool, userId, leadId) {
  const { rows } = await clientOrPool.query(
    `SELECT id FROM saved_leads WHERE id = $1 AND user_id = $2`,
    [leadId, userId]
  );
  return rows[0] || null;
}

/**
 * List appointments for a lead. Sorted: scheduled (by date asc), then completed/cancelled (desc).
 */
async function listAppointments(userId, leadId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT a.id, a.lead_id, a.title, a.description, a.scheduled_at, a.status,
            a.created_at, a.updated_at
     FROM saved_leads sl
     LEFT JOIN saved_lead_appointments a
       ON a.lead_id = sl.id AND a.user_id = $1
     WHERE sl.id = $2 AND sl.user_id = $1
     ORDER BY
       CASE a.status WHEN 'scheduled' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
       CASE WHEN a.status = 'scheduled' THEN a.scheduled_at END ASC NULLS LAST,
       CASE WHEN a.status IS DISTINCT FROM 'scheduled' THEN a.scheduled_at END DESC NULLS LAST`,
    [userId, leadId]
  );

  if (!rows.length) return null;

  const apptRows = rows.filter((r) => r.id != null);
  return {
    items: apptRows.map(mapAppointmentRow),
    upcoming: apptRows.filter((r) => r.status === 'scheduled').map(mapAppointmentRow),
    completed: apptRows.filter((r) => r.status === 'completed').map(mapAppointmentRow),
    cancelled: apptRows.filter((r) => r.status === 'cancelled').map(mapAppointmentRow),
  };
}

async function getAppointment(userId, leadId, appointmentId) {
  const { rows } = await getPool().query(
    `SELECT id, lead_id, title, description, scheduled_at, status, created_at, updated_at
     FROM saved_lead_appointments
     WHERE id = $1 AND lead_id = $2 AND user_id = $3`,
    [appointmentId, leadId, userId]
  );
  if (!rows[0]) return null;
  return mapAppointmentRow(rows[0]);
}

async function createAppointment(userId, leadId, input) {
  const title = validateTitle(input && input.title);
  const description = validateDescription(input && input.description);
  const scheduledAt = parseScheduledAt(input && input.scheduledAt);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const own = await assertLeadOwned(client, userId, leadId);
    if (!own) {
      await client.query('ROLLBACK');
      return null;
    }
    const { rows } = await client.query(
      `INSERT INTO saved_lead_appointments (
         user_id, lead_id, title, description, scheduled_at, status
       ) VALUES ($1, $2, $3, $4, $5::timestamptz, 'scheduled')
       RETURNING id, lead_id, title, description, scheduled_at, status, created_at, updated_at`,
      [userId, leadId, title, description, scheduledAt]
    );
    const { insertOtherActivity } = require('./savedLeadActivities');
    await insertOtherActivity(client, userId, leadId, `Compromisso agendado: ${title}`);
    await client.query('COMMIT');
    return mapAppointmentRow(rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function updateAppointment(userId, leadId, appointmentId, input) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT id, title, description, scheduled_at, status
       FROM saved_lead_appointments
       WHERE id = $1 AND lead_id = $2 AND user_id = $3
       FOR UPDATE`,
      [appointmentId, leadId, userId]
    );
    if (!cur.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const existing = cur.rows[0];
    if (existing.status !== 'scheduled') {
      const err = new Error('Apenas compromissos agendados podem ser editados.');
      err.code = 'VALIDATION';
      await client.query('ROLLBACK');
      throw err;
    }

    const title = input && Object.prototype.hasOwnProperty.call(input, 'title')
      ? validateTitle(input.title)
      : existing.title;
    const description = input && Object.prototype.hasOwnProperty.call(input, 'description')
      ? validateDescription(input.description)
      : existing.description;
    const scheduledAt = input && Object.prototype.hasOwnProperty.call(input, 'scheduledAt')
      ? parseScheduledAt(input.scheduledAt)
      : existing.scheduled_at;

    const { rows } = await client.query(
      `UPDATE saved_lead_appointments
       SET title = $1, description = $2, scheduled_at = $3::timestamptz, updated_at = NOW()
       WHERE id = $4 AND lead_id = $5 AND user_id = $6
       RETURNING id, lead_id, title, description, scheduled_at, status, created_at, updated_at`,
      [title, description, scheduledAt, appointmentId, leadId, userId]
    );

    const { insertOtherActivity } = require('./savedLeadActivities');
    await insertOtherActivity(client, userId, leadId, `Compromisso actualizado: ${title}`);

    await client.query('COMMIT');
    return mapAppointmentRow(rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function completeAppointment(userId, leadId, appointmentId) {
  return setAppointmentStatus(userId, leadId, appointmentId, 'completed', ['scheduled']);
}

async function cancelAppointment(userId, leadId, appointmentId) {
  return setAppointmentStatus(userId, leadId, appointmentId, 'cancelled', ['scheduled']);
}

async function setAppointmentStatus(userId, leadId, appointmentId, nextStatus, allowedFrom) {
  if (!isValidAppointmentStatus(nextStatus)) {
    const err = new Error('Estado de compromisso inválido.');
    err.code = 'VALIDATION';
    throw err;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT id, title, status FROM saved_lead_appointments
       WHERE id = $1 AND lead_id = $2 AND user_id = $3
       FOR UPDATE`,
      [appointmentId, leadId, userId]
    );
    if (!cur.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const row = cur.rows[0];
    if (!allowedFrom.includes(row.status)) {
      const err = new Error(
        row.status === nextStatus
          ? 'O compromisso já está neste estado.'
          : `Não é possível alterar um compromisso com estado «${row.status}».`
      );
      err.code = 'VALIDATION';
      await client.query('ROLLBACK');
      throw err;
    }

    const { rows } = await client.query(
      `UPDATE saved_lead_appointments
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND lead_id = $3 AND user_id = $4
       RETURNING id, lead_id, title, description, scheduled_at, status, created_at, updated_at`,
      [nextStatus, appointmentId, leadId, userId]
    );

    const label = nextStatus === 'completed' ? 'concluído' : 'cancelado';
    const { insertOtherActivity } = require('./savedLeadActivities');
    await insertOtherActivity(client, userId, leadId, `Compromisso ${label}: ${row.title}`);

    await client.query('COMMIT');
    return mapAppointmentRow(rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  APPOINTMENT_STATUSES,
  TITLE_MAX,
  DESCRIPTION_MAX,
  isValidAppointmentStatus,
  listAppointments,
  getAppointment,
  createAppointment,
  updateAppointment,
  completeAppointment,
  cancelAppointment,
  mapAppointmentRow,
};
