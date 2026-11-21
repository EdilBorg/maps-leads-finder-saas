'use strict';
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
  let fx = null;
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
  const key = idempotencyKey || `payzeno:${userId}:${planId}:${method}:${randomUUID()}`;
  const pool = getPool();
  const client = await pool.connect();
  let payment;
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT * FROM payments WHERE idempotency_key = $1`, [key]);
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { payment: paymentService.mapPayment(existing.rows[0]), replayed: true };
    }
    const { rows } = await client.query(
      `INSERT INTO payments (
         user_id, plan_id, amount_cents, currency, method, status,
         idempotency_key, fx_snapshot, gateway_payload
       ) VALUES ($1,$2,$3,$4,'gateway','pending',$5,$6::jsonb,'{}'::jsonb)
       RETURNING *`,
      [userId, planId, quote.amountMinor, quote.currency, key, JSON.stringify(quote.fxSnapshot)]
    );
    payment = rows[0];
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
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
    metadata: { payment_id: payment.id, user_id: userId, plan_id: planId },
    reference: payment.id,
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
    const e = new Error('Não foi possível confirmar a sessão de pagamento. Tente novamente com a mesma chave de idempotência.');
    e.code = 'PAYZENO_UNCERTAIN';
    e.paymentId = payment.id;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const checkoutId = remote.id || remote.checkout_id || remote.session_id || null;
  const checkoutUrl = remote.checkout_url || remote.url || remote.redirect_url || null;
  await getPool().query(
    `UPDATE payments SET external_checkout_id=$2, checkout_url=$3, gateway_payload=$4::jsonb, updated_at=NOW() WHERE id=$1`,
    [payment.id, checkoutId, checkoutUrl, JSON.stringify(remote)]
  );
  const { rows: updated } = await getPool().query(`SELECT * FROM payments WHERE id=$1`, [payment.id]);
  return {
    payment: paymentService.mapPayment(updated[0]),
    checkoutUrl, checkoutId, quote, replayed: false,
  };
}

function verifyWebhookSignature({ rawBody, signature, timestamp, secret }) {
  const sec = secret || webhookSecret();
  if (!sec) return { ok: false, reason: 'NO_SECRET' };
  if (!signature || !rawBody) return { ok: false, reason: 'MISSING' };
  const payload = timestamp ? `${timestamp}.${rawBody}` : rawBody;
  const expected = crypto.createHmac('sha256', sec).update(payload, 'utf8').digest('hex');
  const cleanSig = String(signature).replace(/^v1=/, '').trim();
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(cleanSig, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'MISMATCH' };
  } catch (_) {
    return { ok: false, reason: 'MISMATCH' };
  }
  return { ok: true };
}

async function completePaymentFromGateway({ paymentId, externalPaymentId, eventId, payload }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (eventId) {
      try {
        await client.query(
          `INSERT INTO payment_webhook_events (provider, event_id, event_type, payment_id, payload)
           VALUES ('payzeno',$1,$2,$3,$4::jsonb)`,
          [eventId, payload && payload.type, paymentId, JSON.stringify(payload || {})]
        );
      } catch (e) {
        if (e && e.code === '23505') {
          await client.query('ROLLBACK');
          return { ok: true, replayed: true };
        }
        throw e;
      }
    }
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
    if (pay.status !== 'pending') {
      await client.query('ROLLBACK');
      const err = new Error('Estado de pagamento inválido para confirmação');
      err.code = 'INVALID_STATE';
      throw err;
    }
    await client.query(
      `UPDATE payments SET status='completed', external_payment_id=COALESCE($2, external_payment_id),
         gateway_payload = gateway_payload || $3::jsonb, updated_at=NOW() WHERE id=$1`,
      [paymentId, externalPaymentId || null, JSON.stringify({ completedEvent: payload || {} })]
    );
    await subscriptionService.activateSubscription({
      userId: pay.user_id, planId: pay.plan_id, source: 'gateway',
      externalRef: externalPaymentId || pay.external_checkout_id, client,
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

module.exports = {
  buildCheckoutQuote, createCheckoutSession, verifyWebhookSignature,
  completePaymentFromGateway, allowedMethods, methodCurrency, apiBase,
};
