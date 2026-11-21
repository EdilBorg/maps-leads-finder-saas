'use strict';
/**
 * Payment history mapping. Activation is gateway (PayZeno) or demo when BILLING_DEMO_MODE.
 */
function getPool() {
  return require('../db/pool').getPool();
}

function isDemoPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return payload.demo === true || payload.mode === 'demo';
}

function mapPayment(row) {
  if (!row) return null;
  const gp = row.gateway_payload && typeof row.gateway_payload === 'object'
    ? row.gateway_payload
    : (typeof row.gateway_payload === 'string'
      ? (() => { try { return JSON.parse(row.gateway_payload); } catch (_) { return {}; } })()
      : {});
  return {
    id: row.id,
    userId: row.user_id,
    subscriptionId: row.subscription_id,
    planId: row.plan_id,
    planName: row.plan_name || null,
    amountCents: row.amount_cents,
    currency: row.currency,
    method: row.method,
    status: row.status,
    reference: row.reference,
    proofUrl: row.proof_url,
    idempotencyKey: row.idempotency_key,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    externalCheckoutId: row.external_checkout_id || null,
    externalPaymentId: row.external_payment_id || null,
    checkoutUrl: row.checkout_url || null,
    fxSnapshot: row.fx_snapshot || {},
    isDemo: isDemoPayload(gp),
  };
}

async function listPaymentsForUser(userId) {
  const { rows } = await getPool().query(
    `SELECT p.*, pl.name AS plan_name FROM payments p
     JOIN plans pl ON pl.id = p.plan_id WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
    [userId]
  );
  return rows.map(mapPayment);
}

module.exports = {
  listPaymentsForUser,
  mapPayment,
};
