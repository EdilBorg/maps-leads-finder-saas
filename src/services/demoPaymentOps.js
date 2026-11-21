'use strict';

/**
 * Hardened demo payment confirm/cancel.
 * Loaded by billing routes to enforce pending-only + plan validation.
 */

async function confirmDemoPaymentHardened(deps, { userId, paymentId }) {
  const {
    isBillingDemoMode, isDemoPaymentRow, getPool,
    paymentService, subscriptionService, planService,
  } = deps;

  if (!isBillingDemoMode()) {
    const err = new Error('Modo de demonstração desactivado.');
    err.code = 'DEMO_DISABLED';
    throw err;
  }
  if (!paymentId) {
    const err = new Error('paymentId obrigatório');
    err.code = 'NO_REFERENCE';
    throw err;
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM payments WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [paymentId, userId]
    );
    const pay = rows[0];
    if (!pay) {
      await client.query('ROLLBACK');
      const err = new Error('Pagamento não encontrado');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (String(pay.user_id) !== String(userId)) {
      await client.query('ROLLBACK');
      const err = new Error('Pagamento não pertence a este utilizador.');
      err.code = 'OWNERSHIP';
      throw err;
    }
    if (!isDemoPaymentRow(pay)) {
      await client.query('ROLLBACK');
      const err = new Error('Este pagamento não é de demonstração.');
      err.code = 'NOT_DEMO';
      throw err;
    }
    if (pay.status === 'completed' || pay.status === 'approved') {
      await client.query('COMMIT');
      return { ok: true, replayed: true, payment: paymentService.mapPayment(pay) };
    }
    if (pay.status !== 'pending') {
      await client.query('ROLLBACK');
      const err = new Error('Apenas pagamentos demo pendentes podem ser confirmados.');
      err.code = 'INVALID_STATE';
      throw err;
    }

    let planRow = null;
    try {
      planRow = await planService.getPlanById(pay.plan_id, client);
    } catch (_) {
      planRow = null;
    }
    if (!planRow) {
      const pr = await client.query(`SELECT * FROM plans WHERE id = $1`, [pay.plan_id]);
      planRow = pr.rows[0] || null;
    }
    if (!planRow) {
      await client.query('ROLLBACK');
      const err = new Error('Plano associado ao pagamento não encontrado.');
      err.code = 'PLAN_NOT_FOUND';
      throw err;
    }
    const planName = String(planRow.name || '').toLowerCase();
    const planActive = planRow.active == null ? true : !!planRow.active;
    if (planName !== 'pro' || !planActive) {
      await client.query('ROLLBACK');
      const err = new Error('Plano inválido ou inactivo para confirmação demo.');
      err.code = 'PLAN_INVALID';
      throw err;
    }
    if (pay.amount_cents == null || !Number.isFinite(Number(pay.amount_cents)) || Number(pay.amount_cents) <= 0) {
      await client.query('ROLLBACK');
      const err = new Error('Valor do pagamento inválido.');
      err.code = 'AMOUNT_INVALID';
      throw err;
    }
    if (!pay.currency) {
      await client.query('ROLLBACK');
      const err = new Error('Moeda do pagamento inválida.');
      err.code = 'CURRENCY_INVALID';
      throw err;
    }

    const sub = await subscriptionService.activateSubscription({
      userId: pay.user_id,
      planId: pay.plan_id,
      source: 'demo',
      externalRef: `demo:${pay.id}`,
      client,
    });
    await client.query(
      `UPDATE payments SET status='completed',
         subscription_id=$2,
         external_payment_id=COALESCE(external_payment_id, $3),
         gateway_payload = gateway_payload || $4::jsonb,
         updated_at=NOW()
       WHERE id=$1`,
      [
        pay.id,
        sub && sub.id ? sub.id : null,
        `demo-paid-${pay.id}`,
        JSON.stringify({ demoConfirmedAt: new Date().toISOString() }),
      ]
    );
    await client.query('COMMIT');
    const { rows: updated } = await pool.query(`SELECT * FROM payments WHERE id=$1`, [pay.id]);
    return {
      ok: true,
      replayed: false,
      payment: paymentService.mapPayment(updated[0]),
      subscription: sub,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function cancelDemoPaymentHardened(deps, { userId, paymentId }) {
  const { isBillingDemoMode, isDemoPaymentRow, getPool, paymentService } = deps;
  if (!isBillingDemoMode()) {
    const err = new Error('Modo de demonstração desactivado.');
    err.code = 'DEMO_DISABLED';
    throw err;
  }
  if (!paymentId) {
    const err = new Error('paymentId obrigatório');
    err.code = 'NO_REFERENCE';
    throw err;
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM payments WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [paymentId, userId]
    );
    const pay = rows[0];
    if (!pay) {
      await client.query('ROLLBACK');
      const err = new Error('Pagamento não encontrado');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (!isDemoPaymentRow(pay)) {
      await client.query('ROLLBACK');
      const err = new Error('Este pagamento não é de demonstração.');
      err.code = 'NOT_DEMO';
      throw err;
    }
    if (pay.status === 'cancelled' || pay.status === 'canceled') {
      await client.query('COMMIT');
      return { ok: true, replayed: true, payment: paymentService.mapPayment(pay) };
    }
    if (pay.status === 'completed' || pay.status === 'approved') {
      await client.query('ROLLBACK');
      const err = new Error('Pagamento já confirmado; não pode ser cancelado.');
      err.code = 'INVALID_STATE';
      throw err;
    }
    if (pay.status !== 'pending') {
      await client.query('ROLLBACK');
      const err = new Error('Apenas pagamentos demo pendentes podem ser cancelados.');
      err.code = 'INVALID_STATE';
      throw err;
    }
    await client.query(
      `UPDATE payments SET status='cancelled',
         gateway_payload = gateway_payload || $2::jsonb,
         updated_at=NOW()
       WHERE id=$1`,
      [pay.id, JSON.stringify({ demoCancelledAt: new Date().toISOString() })]
    );
    await client.query('COMMIT');
    const { rows: updated } = await pool.query(`SELECT * FROM payments WHERE id=$1`, [pay.id]);
    return { ok: true, replayed: false, payment: paymentService.mapPayment(updated[0]) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { confirmDemoPaymentHardened, cancelDemoPaymentHardened };
