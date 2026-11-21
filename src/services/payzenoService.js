'use strict';
/**
 * PayZeno hosted checkout integration.
 * Docs: https://www.payzeno.io/api
 * OpenAPI: https://api.payzeno.io/swagger/v1/swagger.json
 *
 * Webhook signature: official PayZeno HMAC contract is unconfirmed.
 * Webhook processing remains fail-closed until the provider confirms it.
 */
const { randomUUID } = require('crypto');
const fxRateService = require('./fxRateService');
const planService = require('./planService');
const paymentService = require('./paymentService');
const subscriptionService = require('./subscriptionService');

function getPool() { return require('../db/pool').getPool(); }
function apiBase() {
  return (process.env.PAYZENO_API_BASE || 'https://api.payzeno.io').replace(/\/$/, '');
}
function apiKey() { return process.env.PAYZENO_API_KEY || ''; }
function isBillingDemoMode() {
  return String(process.env.BILLING_DEMO_MODE || '').toLowerCase() === 'true';
}
function allowedMethods() {
  const raw = process.env.PAYZENO_PAYMENT_METHODS || 'mpesa,emola,multicaixa,payfast,card';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const METHOD_CURRENCY = Object.freeze({
  mpesa: 'MZN', emola: 'MZN', multicaixa: 'AOA', payfast: 'ZAR', card: 'USD',
});
function methodCurrency(method) {
  return METHOD_CURRENCY[String(method || '').toLowerCase()] || null;
}

function isDemoPaymentRow(pay) {
  if (!pay) return false;
  const gp = pay.gateway_payload || {};
  if (gp.demo === true || gp.isDemo === true || gp.source === 'demo') return true;
  if (pay.external_checkout_id && String(pay.external_checkout_id).startsWith('demo-')) return true;
  return false;
}

async function buildCheckoutQuote({ planId, method }) {
  const plan = await planService.getPlanById(planId);
  if (!plan || !plan.isActive) {
    const err = new Error('Plano não encontrado ou inactivo.');
    err.code = 'PLAN_NOT_FOUND';
    throw err;
  }
  const m = String(method || '').toLowerCase();
  if (!allowedMethods().includes(m)) {
    const err = new Error('Método de pagamento não disponível.');
    err.code = 'METHOD_NOT_ALLOWED';
    throw err;
  }
  const currency = methodCurrency(m);
  if (!currency) {
    const err = new Error('Moeda não suportada para este método.');
    err.code = 'CURRENCY_UNSUPPORTED';
    throw err;
  }
  const baseCents = plan.priceCents;
  let chargeMinor = baseCents;
  let chargeMajor = baseCents / 100;
  let fx;
  if (currency !== 'USD') {
    const rateInfo = await fxRateService.getUsdRate(currency);
    const conv = fxRateService.convertUsdCentsToLocal(baseCents, rateInfo.rate, { minorFactor: 100 });
    chargeMajor = conv.majorUnits;
    chargeMinor = conv.minorUnits;
    fx = {
      baseCurrency: 'USD', baseAmountCents: baseCents, quoteCurrency: currency,
      rate: rateInfo.rate, rateDate: rateInfo.rateDate, source: rateInfo.source,
      fetchedAt: rateInfo.fetchedAt, localMajorUnits: conv.majorUnits, localMinorUnits: conv.minorUnits,
    };
  } else {
    fx = {
      baseCurrency: 'USD', baseAmountCents: baseCents, quoteCurrency: 'USD', rate: 1,
      rateDate: new Date().toISOString().slice(0, 10), source: 'identity',
      localMajorUnits: chargeMajor, localMinorUnits: chargeMinor,
    };
  }
  return { plan, method: m, currency, amountMinor: chargeMinor, amountMajor: chargeMajor, fxSnapshot: fx };
}

async function finalizeDemoCheckout({ payment, quote, userId, customer, successUrl }) {
  const checkoutId = `demo-${payment.id}`;
  const checkoutUrl = `${successUrl || '/'}?billing=demo&paymentId=${payment.id}`;
  await getPool().query(
    `UPDATE payments SET external_checkout_id=$2, checkout_url=$3,
       gateway_payload = gateway_payload || $4::jsonb, updated_at=NOW() WHERE id=$1`,
    [payment.id, checkoutId, checkoutUrl, JSON.stringify({ demo: true, source: 'demo', customer: customer || null })]
  );
  const { rows } = await getPool().query(`SELECT * FROM payments WHERE id=$1`, [payment.id]);
  return {
    payment: paymentService.mapPayment(rows[0]),
    checkoutUrl,
    checkoutId,
    quote,
    replayed: false,
    demo: true,
  };
}

async function createCheckoutSession({
  userId, planId, method, customer, successUrl, cancelUrl, idempotencyKey,
}) {
  const demo = isBillingDemoMode();
  if (!demo && !apiKey()) {
    const err = new Error('Pagamentos automáticos não estão configurados.');
    err.code = 'PAYZENO_NOT_CONFIGURED';
    throw err;
  }
  const quote = await buildCheckoutQuote({ planId, method });
  let clientToken = idempotencyKey
    ? String(idempotencyKey).replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 64)
    : '';
  if (!clientToken) clientToken = randomUUID();
  let key = `payzeno:u:${userId}:p:${planId}:m:${quote.method}:t:${clientToken}`;
  const pool = getPool();
  const client = await pool.connect();
  let payment;
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT * FROM payments WHERE idempotency_key = $1 AND user_id = $2`,
      [key, userId]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (String(row.user_id) !== String(userId)) {
        await client.query('ROLLBACK');
        const err = new Error('Pagamento não pertence a este utilizador.');
        err.code = 'OWNERSHIP';
        throw err;
      }
      await client.query('COMMIT');
      if (row.checkout_url && (row.status === 'pending' || row.status === 'processing')) {
        return {
          payment: paymentService.mapPayment(row),
          checkoutUrl: row.checkout_url,
          checkoutId: row.external_checkout_id,
          quote,
          replayed: true,
          demo: isDemoPaymentRow(row),
        };
      }
      if (row.status === 'completed' || row.status === 'approved') {
        const err = new Error('Já existe um pagamento concluído para esta tentativa. Inicie um novo checkout.');
        err.code = 'ALREADY_PAID';
        throw err;
      }
      key = `payzeno:u:${userId}:p:${planId}:m:${quote.method}:t:${randomUUID()}`;
    }
    const { rows } = await client.query(
      `INSERT INTO payments (
         user_id, plan_id, amount_cents, currency, method, status,
         idempotency_key, reference, fx_snapshot, gateway_payload
       ) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8::jsonb,'{}'::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        userId, planId, quote.amountMinor, quote.currency, quote.method,
        key, String(userId),
        JSON.stringify(quote.fxSnapshot),
      ]
    );
    if (rows[0]) {
      payment = rows[0];
    } else {
      const again = await client.query(
        `SELECT * FROM payments WHERE idempotency_key = $1 AND user_id = $2`,
        [key, userId]
      );
      payment = again.rows[0];
    }
    if (payment && payment.id) {
      await client.query(
        `UPDATE payments SET reference = $2 WHERE id = $1 AND (reference IS NULL OR reference = $3)`,
        [payment.id, String(payment.id), key]
      );
      payment.reference = String(payment.id);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }

  if (payment.checkout_url && payment.status === 'pending') {
    return {
      payment: paymentService.mapPayment(payment),
      checkoutUrl: payment.checkout_url,
      checkoutId: payment.external_checkout_id,
      quote,
      replayed: true,
      demo: isDemoPaymentRow(payment),
    };
  }

  if (demo) {
    return finalizeDemoCheckout({ payment, quote, userId, customer, successUrl });
  }

  const body = {
    amount: quote.amountMinor,
    currency: quote.currency,
    payment_methods: [quote.method],
    customer: {
      name: customer && customer.name,
      phone: customer && customer.phone,
      email: customer && customer.email ? customer.email : undefined,
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
    reference: String(payment.id),
    description: `Maps Leads Finder — Plano ${quote.plan.name}`,
    metadata: { payment_id: payment.id, user_id: userId, plan_id: planId },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let remote;
  try {
    const res = await fetch(`${apiBase()}/v1/checkout/sessions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Api-Key': apiKey(),
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      await getPool().query(
        `UPDATE payments SET status='failed', gateway_payload=$2::jsonb, updated_at=NOW() WHERE id=$1`,
        [payment.id, JSON.stringify({ error: data, status: res.status })]
      );
      const err = new Error((data && data.message) || `PayZeno HTTP ${res.status}`);
      err.code = 'PAYZENO_HTTP';
      err.status = res.status;
      throw err;
    }
    remote = data;
  } catch (err) {
    if (err.code === 'PAYZENO_HTTP') throw err;
    await getPool().query(
      `UPDATE payments SET gateway_payload=$2::jsonb, updated_at=NOW() WHERE id=$1`,
      [payment.id, JSON.stringify({ uncertain: true, error: String(err.message || err) })]
    );
    const e = new Error('Não foi possível confirmar a sessão de pagamento. Repita com a mesma chave.');
    e.code = 'PAYZENO_UNCERTAIN';
    e.paymentId = payment.id;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const checkoutId = remote.checkout_id || remote.id || remote.session_id || null;
  const checkoutUrl = remote.checkout_url || remote.url || remote.redirect_url || null;
  if (!checkoutUrl) {
    await getPool().query(
      `UPDATE payments SET status='failed', gateway_payload=$2::jsonb, updated_at=NOW() WHERE id=$1`,
      [payment.id, JSON.stringify({ error: 'missing_checkout_url', remote })]
    );
    const err = new Error('PayZeno não devolveu URL de checkout.');
    err.code = 'PAYZENO_NO_URL';
    throw err;
  }

  await getPool().query(
    `UPDATE payments SET external_checkout_id=$2, checkout_url=$3, gateway_payload=$4::jsonb,
       reference=COALESCE(reference, $5), updated_at=NOW() WHERE id=$1`,
    [payment.id, checkoutId, checkoutUrl, JSON.stringify(remote), String(payment.id)]
  );
  const { rows: updated } = await getPool().query(`SELECT * FROM payments WHERE id=$1`, [payment.id]);
  return {
    payment: paymentService.mapPayment(updated[0]),
    checkoutUrl,
    checkoutId,
    quote,
    replayed: false,
  };
}

function verifyWebhookSignature() {
  return {
    ok: false,
    reason: 'SIGNATURE_CONTRACT_UNCONFIRMED',
    documented: false,
  };
}

async function handleWebhookPayload(payload) {
  return { ok: true, ignored: true, reason: 'webhook_fail_closed_until_hmac_confirmed' };
}

async function completePaymentFromGateway() {
  const err = new Error('Webhook fail-closed até HMAC confirmado.');
  err.code = 'SIGNATURE_CONTRACT_UNCONFIRMED';
  throw err;
}

async function getPaymentForUser(userId, paymentId) {
  const { rows } = await getPool().query(
    `SELECT * FROM payments WHERE id = $1 AND user_id = $2`,
    [paymentId, userId]
  );
  return rows[0] ? paymentService.mapPayment(rows[0]) : null;
}

async function fetchRemoteSessionStatus(checkoutId) {
  if (!checkoutId || String(checkoutId).startsWith('demo-')) {
    return { status: 'pending', demo: true };
  }
  if (!apiKey()) return { status: 'unknown' };
  try {
    const res = await fetch(`${apiBase()}/v1/checkout/sessions/${encodeURIComponent(checkoutId)}`, {
      headers: { Accept: 'application/json', 'Api-Key': apiKey() },
    });
    if (!res.ok) return { status: 'unknown', http: res.status };
    return await res.json();
  } catch (e) {
    return { status: 'unknown', error: String(e.message || e) };
  }
}

async function confirmDemoPayment({ userId, paymentId }) {
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

async function cancelDemoPayment({ userId, paymentId }) {
  if (!isBillingDemoMode()) {
    const err = new Error('Modo de demonstração desactivado.');
    err.code = 'DEMO_DISABLED';
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

module.exports = {
  buildCheckoutQuote,
  createCheckoutSession,
  verifyWebhookSignature,
  handleWebhookPayload,
  completePaymentFromGateway,
  getPaymentForUser,
  fetchRemoteSessionStatus,
  allowedMethods,
  methodCurrency,
  apiBase,
  isBillingDemoMode,
  confirmDemoPayment,
  cancelDemoPayment,
  isDemoPaymentRow,
};
