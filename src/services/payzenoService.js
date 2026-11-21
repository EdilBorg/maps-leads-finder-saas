'use strict';
/**
 * PayZeno hosted checkout integration.
 * Docs: https://www.payzeno.io/api
 * OpenAPI: https://api.payzeno.io/swagger/v1/swagger.json
 *
 * Webhook signature: public OpenAPI does not document HMAC headers/format.
 * We require PAYZENO_WEBHOOK_SECRET and accept common HMAC-SHA256 patterns
 * (raw body, or timestamp.body) with hex digest. This is a defensive measure;
 * production readiness requires confirmation of the official signature contract.
 */
const crypto = require('crypto');
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
function webhookSecret() { return process.env.PAYZENO_WEBHOOK_SECRET || ''; }
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

async function createCheckoutSession({
  userId, planId, method, customer, successUrl, cancelUrl, idempotencyKey,
}) {
  if (!apiKey()) {
    const err = new Error('Pagamentos automáticos não estão configurados.');
    err.code = 'PAYZENO_NOT_CONFIGURED';
    throw err;
  }
  const quote = await buildCheckoutQuote({ planId, method });
  const key = idempotencyKey || `payzeno:${userId}:${planId}:${method}`;
  const pool = getPool();
  const client = await pool.connect();
  let payment;
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT * FROM payments WHERE idempotency_key = $1`, [key]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      await client.query('COMMIT');
      if (row.checkout_url && (row.status === 'pending' || row.status === 'processing')) {
        return {
          payment: paymentService.mapPayment(row),
          checkoutUrl: row.checkout_url,
          checkoutId: row.external_checkout_id,
          quote,
          replayed: true,
        };
      }
      // Terminal or incomplete previous attempt with same key → new key suffix
      if (row.status === 'completed' || row.status === 'approved') {
        const err = new Error('Já existe um pagamento concluído para este pedido.');
        err.code = 'ALREADY_PAID';
        throw err;
      }
    }
    const { rows } = await client.query(
      `INSERT INTO payments (
         user_id, plan_id, amount_cents, currency, method, status,
         idempotency_key, reference, fx_snapshot, gateway_payload
       ) VALUES ($1,$2,$3,$4,'gateway','pending',$5,$6,$7::jsonb,'{}'::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        userId, planId, quote.amountMinor, quote.currency, key,
        key, // reference = internal key / payment association
        JSON.stringify(quote.fxSnapshot),
      ]
    );
    if (rows[0]) {
      payment = rows[0];
    } else {
      const again = await client.query(`SELECT * FROM payments WHERE idempotency_key = $1`, [key]);
      payment = again.rows[0];
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
    };
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

/**
 * Webhook signature verification.
 * Official public docs do not specify header names or HMAC format.
 * Accepts HMAC-SHA256 hex of rawBody or `${timestamp}.${rawBody}` against
 * X-PayZeno-Signature / X-Signature / Payzeno-Signature (optional v1= prefix).
 */
function verifyWebhookSignature({ rawBody, signature, timestamp, secret }) {
  const sec = secret || webhookSecret();
  if (!sec) return { ok: false, reason: 'NO_SECRET', documented: false };
  if (!signature || rawBody == null) return { ok: false, reason: 'MISSING', documented: false };
  const cleanSig = String(signature).replace(/^v1=/, '').trim();
  const candidates = [String(rawBody)];
  if (timestamp) candidates.push(`${timestamp}.${rawBody}`);
  for (const payload of candidates) {
    const expected = crypto.createHmac('sha256', sec).update(payload, 'utf8').digest('hex');
    try {
      const a = Buffer.from(expected, 'hex');
      const b = Buffer.from(cleanSig, 'hex');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { ok: true, documented: false, pattern: payload === rawBody ? 'body' : 'timestamp.body' };
      }
    } catch (_) { /* continue */ }
  }
  return { ok: false, reason: 'MISMATCH', documented: false };
}

async function recordWebhookEvent({ eventId, eventType, paymentId, payload }) {
  if (!eventId) return { inserted: false };
  try {
    await getPool().query(
      `INSERT INTO payment_webhook_events (provider, event_id, event_type, payment_id, payload)
       VALUES ('payzeno',$1,$2,$3,$4::jsonb)`,
      [eventId, eventType || null, paymentId || null, JSON.stringify(payload || {})]
    );
    return { inserted: true };
  } catch (e) {
    if (e && e.code === '23505') return { inserted: false, duplicate: true };
    throw e;
  }
}

function resolveInternalPaymentId(payload) {
  return (
    (payload.metadata && payload.metadata.payment_id) ||
    payload.reference ||
    (payload.data && payload.data.reference) ||
    null
  );
}

/**
 * Process official webhook events.
 * payment.succeeded → validate + complete + activate subscription
 * payment.refunded / payment.chargeback → mark and revoke access policy
 */
async function handleWebhookPayload(payload) {
  const event = String(payload.event || payload.type || '').toLowerCase();
  const status = String(payload.status || '').toLowerCase();
  const eventId =
    payload.event_id ||
    payload.id ||
    (event && payload.payment_id ? `${event}:${payload.payment_id}:${payload.paid_at || ''}` : null);
  const internalId = resolveInternalPaymentId(payload);
  const checkoutId = payload.checkout_id || null;
  const externalPaymentId = payload.payment_id || null;

  const rec = await recordWebhookEvent({
    eventId: eventId || `anon:${Date.now()}`,
    eventType: event || status,
    paymentId: internalId,
    payload,
  });
  if (rec.duplicate) {
    return { ok: true, replayed: true, reason: 'duplicate_event' };
  }

  if (event === 'payment.succeeded' || status === 'succeeded' || status === 'paid') {
    return completePaymentFromGateway({
      paymentId: internalId,
      externalPaymentId,
      checkoutId,
      amount: payload.amount,
      currency: payload.currency,
      eventId,
      payload,
    });
  }

  if (event === 'payment.refunded' || status === 'refunded') {
    return markPaymentTerminal({
      paymentId: internalId,
      checkoutId,
      externalPaymentId,
      nextStatus: 'refunded',
      payload,
    });
  }

  if (event === 'payment.chargeback' || status === 'chargeback') {
    return markPaymentTerminal({
      paymentId: internalId,
      checkoutId,
      externalPaymentId,
      nextStatus: 'chargeback',
      payload,
    });
  }

  return { ok: true, ignored: true, event, status };
}

async function completePaymentFromGateway({
  paymentId, externalPaymentId, checkoutId, amount, currency, eventId, payload,
}) {
  if (!paymentId) {
    const err = new Error('Referência de pagamento em falta no webhook');
    err.code = 'NO_REFERENCE';
    throw err;
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    const pay = rows[0];
    if (!pay) {
      await client.query('ROLLBACK');
      const err = new Error('Pagamento não encontrado');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (pay.status === 'completed' || pay.status === 'approved') {
      await client.query('COMMIT');
      return { ok: true, replayed: true, payment: paymentService.mapPayment(pay) };
    }
    if (['refunded', 'chargeback', 'failed', 'cancelled', 'expired'].includes(pay.status)) {
      await client.query('ROLLBACK');
      const err = new Error('Pagamento em estado terminal incompatível com succeeded');
      err.code = 'INVALID_STATE';
      throw err;
    }
    if (pay.status !== 'pending' && pay.status !== 'processing') {
      await client.query('ROLLBACK');
      const err = new Error('Estado de pagamento inválido para confirmação');
      err.code = 'INVALID_STATE';
      throw err;
    }
    // Validate external identifiers when stored
    if (checkoutId && pay.external_checkout_id && String(pay.external_checkout_id) !== String(checkoutId)) {
      await client.query('ROLLBACK');
      const err = new Error('checkout_id não corresponde ao pagamento interno');
      err.code = 'CHECKOUT_MISMATCH';
      throw err;
    }
    if (amount != null && Number(pay.amount_cents) !== Number(amount)) {
      await client.query('ROLLBACK');
      const err = new Error('Valor do webhook não corresponde ao pagamento');
      err.code = 'AMOUNT_MISMATCH';
      throw err;
    }
    if (currency && String(pay.currency).toUpperCase() !== String(currency).toUpperCase()) {
      await client.query('ROLLBACK');
      const err = new Error('Moeda do webhook não corresponde ao pagamento');
      err.code = 'CURRENCY_MISMATCH';
      throw err;
    }

    await client.query(
      `UPDATE payments SET status='completed',
         external_payment_id=COALESCE($2, external_payment_id),
         external_checkout_id=COALESCE($3, external_checkout_id),
         gateway_payload = gateway_payload || $4::jsonb,
         updated_at=NOW()
       WHERE id=$1`,
      [
        paymentId,
        externalPaymentId || null,
        checkoutId || null,
        JSON.stringify({ completedEvent: payload || {}, eventId: eventId || null }),
      ]
    );
    await subscriptionService.activateSubscription({
      userId: pay.user_id,
      planId: pay.plan_id,
      source: 'gateway',
      externalRef: externalPaymentId || pay.external_checkout_id || pay.id,
      client,
    });
    await client.query('COMMIT');
    const { rows: updated } = await pool.query(`SELECT * FROM payments WHERE id=$1`, [paymentId]);
    return { ok: true, replayed: false, payment: paymentService.mapPayment(updated[0]) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function markPaymentTerminal({ paymentId, checkoutId, externalPaymentId, nextStatus, payload }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let pay = null;
    if (paymentId) {
      const { rows } = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
      pay = rows[0];
    } else if (checkoutId) {
      const { rows } = await client.query(
        `SELECT * FROM payments WHERE external_checkout_id = $1 FOR UPDATE`,
        [checkoutId]
      );
      pay = rows[0];
    }
    if (!pay) {
      await client.query('COMMIT');
      return { ok: true, ignored: true, reason: 'payment_not_found' };
    }
    // Do not overwrite completed with weaker states without explicit policy
    if (pay.status === nextStatus) {
      await client.query('COMMIT');
      return { ok: true, replayed: true, payment: paymentService.mapPayment(pay) };
    }
    await client.query(
      `UPDATE payments SET status=$2,
         external_payment_id=COALESCE($3, external_payment_id),
         gateway_payload = gateway_payload || $4::jsonb,
         updated_at=NOW()
       WHERE id=$1`,
      [pay.id, nextStatus, externalPaymentId || null, JSON.stringify({ terminalEvent: payload || {} })]
    );
    // Revoke active gateway subscription for this plan when refunded/chargeback
    if (nextStatus === 'refunded' || nextStatus === 'chargeback') {
      await client.query(
        `UPDATE subscriptions SET status='cancelled', updated_at=NOW()
         WHERE user_id=$1 AND plan_id=$2 AND status='active' AND source='gateway'`,
        [pay.user_id, pay.plan_id]
      );
    }
    await client.query('COMMIT');
    return { ok: true, payment: paymentService.mapPayment({ ...pay, status: nextStatus }) };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function getPaymentForUser(userId, paymentId) {
  const { rows } = await getPool().query(
    `SELECT p.*, pl.name AS plan_name FROM payments p
     JOIN plans pl ON pl.id = p.plan_id
     WHERE p.id = $1 AND p.user_id = $2`,
    [paymentId, userId]
  );
  return rows[0] ? paymentService.mapPayment(rows[0]) : null;
}

async function fetchRemoteSessionStatus(checkoutId) {
  if (!apiKey() || !checkoutId) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`${apiBase()}/v1/checkout/sessions/${encodeURIComponent(checkoutId)}/status`, {
      headers: { Accept: 'application/json', 'Api-Key': apiKey() },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    if (!res.ok) return { ok: false, status: res.status, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
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
};
