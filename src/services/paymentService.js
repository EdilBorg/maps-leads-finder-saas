/**
 * Manual payments; hybrid architecture ready for gateway.
 * Creation is idempotent under concurrency via unique idempotency_key + catch of unique_violation.
 */
const crypto = require('crypto');
const subscriptionService = require('./subscriptionService');

function getPool() { return require('../db/pool').getPool(); }

async function createManualPayment({
  userId, planId, amountCents, currency = 'USD',
  reference = null, proofUrl = null, idempotencyKey = null,
}) {
  const pool = getPool();
  const key = idempotencyKey || `pay:${userId}:${planId}:${crypto.randomUUID()}`;

  // Fast path (outside tx) — reduces contention for pure replays
  const existing = await pool.query(`SELECT * FROM payments WHERE idempotency_key = $1`, [key]);
  if (existing.rows[0]) return { payment: mapPayment(existing.rows[0]), replayed: true };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-check under transaction to close the race window
    const again = await client.query(`SELECT * FROM payments WHERE idempotency_key = $1 FOR SHARE`, [key]);
    if (again.rows[0]) {
      await client.query('COMMIT');
      return { payment: mapPayment(again.rows[0]), replayed: true };
    }

    const subIns = await client.query(
      `INSERT INTO subscriptions (user_id, plan_id, status, source)
       VALUES ($1, $2, 'pending', 'manual') RETURNING id`,
      [userId, planId]
    );
    const subscriptionId = subIns.rows[0].id;
    const { rows } = await client.query(
      `INSERT INTO payments (
         user_id, subscription_id, plan_id, amount_cents, currency,
         method, status, reference, proof_url, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,'manual','pending',$6,$7,$8) RETURNING *`,
      [userId, subscriptionId, planId, amountCents != null ? amountCents : 0, currency, reference, proofUrl, key]
    );
    await client.query('COMMIT');
    return { payment: mapPayment(rows[0]), subscriptionId, replayed: false };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    // Unique violation on idempotency_key → another concurrent request won; return that row
    if (err && (err.code === '23505' || /unique/i.test(String(err.message || '')))) {
      const { rows } = await pool.query(`SELECT * FROM payments WHERE idempotency_key = $1`, [key]);
      if (rows[0]) return { payment: mapPayment(rows[0]), replayed: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function listPaymentsForUser(userId) {
  const { rows } = await getPool().query(
    `SELECT p.*, pl.name AS plan_name FROM payments p
     JOIN plans pl ON pl.id = p.plan_id WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
    [userId]
  );
  return rows.map(mapPayment);
}

async function listPendingPayments() {
  const { rows } = await getPool().query(
    `SELECT p.*, pl.name AS plan_name, u.email AS user_email
     FROM payments p
     JOIN plans pl ON pl.id = p.plan_id
     JOIN users u ON u.id = p.user_id
     WHERE p.status = 'pending' ORDER BY p.created_at ASC`
  );
  return rows.map((r) => ({ ...mapPayment(r), userEmail: r.user_email }));
}

async function approvePayment(paymentId, adminUserId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT lock_tenant_subscription(subscription_id) FROM payments WHERE id = $1`, [paymentId]);
    } catch (_) { /* helper may not exist in all envs */ }

    const { rows } = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const pay = rows[0];
    if (!pay) { await client.query('ROLLBACK'); return { ok: false, reason: 'NOT_FOUND' }; }
    if (pay.status === 'approved' || pay.status === 'completed') {
      await client.query('COMMIT');
      return { ok: true, replayed: true, payment: mapPayment(pay) };
    }
    if (pay.status !== 'pending') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'INVALID_STATUS', status: pay.status };
    }

    await client.query(
      `UPDATE payments SET status='approved', reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [paymentId, adminUserId]
    );

    const sub = await subscriptionService.activateSubscription({
      userId: pay.user_id, planId: pay.plan_id, source: 'manual', externalRef: pay.id, client,
    });

    if (pay.subscription_id) {
      await client.query(
        `UPDATE subscriptions SET status='cancelled', updated_at=NOW()
         WHERE id=$1 AND status='pending'`,
        [pay.subscription_id]
      );
    }

    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1,'payment.approve','payment',$2,$3::jsonb)`,
      [adminUserId, paymentId, JSON.stringify({ subscriptionId: sub.id })]
    );
    await client.query('COMMIT');
    const { rows: updated } = await pool.query(`SELECT * FROM payments WHERE id=$1`, [paymentId]);
    return { ok: true, payment: mapPayment(updated[0]), subscription: sub, replayed: false };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function rejectPayment(paymentId, adminUserId, reason = null) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [paymentId]);
    const pay = rows[0];
    if (!pay) { await client.query('ROLLBACK'); return { ok: false, reason: 'NOT_FOUND' }; }
    if (pay.status === 'rejected') {
      await client.query('COMMIT');
      return { ok: true, replayed: true, payment: mapPayment(pay) };
    }
    if (pay.status !== 'pending') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'INVALID_STATUS' };
    }
    await client.query(
      `UPDATE payments SET status='rejected', reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW(),
         gateway_payload = gateway_payload || $3::jsonb WHERE id=$1`,
      [paymentId, adminUserId, JSON.stringify({ rejectReason: reason || null })]
    );
    if (pay.subscription_id) {
      await client.query(
        `UPDATE subscriptions SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status='pending'`,
        [pay.subscription_id]
      );
    }
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1,'payment.reject','payment',$2,$3::jsonb)`,
      [adminUserId, paymentId, JSON.stringify({ reason })]
    );
    await client.query('COMMIT');
    const { rows: updated } = await pool.query(`SELECT * FROM payments WHERE id=$1`, [paymentId]);
    return { ok: true, payment: mapPayment(updated[0]), replayed: false };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

function mapPayment(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, subscriptionId: row.subscription_id,
    planId: row.plan_id, planName: row.plan_name || null,
    amountCents: row.amount_cents, currency: row.currency,
    method: row.method, status: row.status, reference: row.reference,
    proofUrl: row.proof_url, idempotencyKey: row.idempotency_key,
    reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

module.exports = {
  createManualPayment, listPaymentsForUser, listPendingPayments,
  approvePayment, rejectPayment, mapPayment,
};
