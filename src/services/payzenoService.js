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

/** Historical DEMO rows only — never activates subscriptions. */
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
    const conv = fxRateService.convertUsdCentsToLocal(baseCents, rateInfo.rate, { currency });
    // Default: keep minor-unit ceil from FX conversion.
    chargeMajor = conv.majorUnits;
    chargeMinor = conv.minorUnits;

    // Non-card methods (M-Pesa, e-Mola, Multicaixa, PayFast) must charge a whole
    // major unit (integer). Apply Math.ceil to the major amount and recompute minor.
    // Card keeps the full decimal precision of the conversion.
    if (m !== 'card') {
      const digits = conv.minorDigits;
      const factor = 10 ** digits;
      const ceiledMajor = Math.ceil(chargeMajor);
      // Guard against floating-point noise: if already extremely close to integer, keep it.
      // Still use ceil for any positive fractional part.
      chargeMajor = ceiledMajor;
      chargeMinor = ceiledMajor * factor;
    }

    fx = {
      baseCurrency: 'USD',
      baseAmountCents: baseCents,
      quoteCurrency: currency,
      rate: rateInfo.rate,
      rateDate: rateInfo.rateDate,
      source: rateInfo.source,
      fetchedAt: rateInfo.fetchedAt,
      localMajorUnits: chargeMajor,
      localMinorUnits: chargeMinor,
      minorDigits: conv.minorDigits,
    };
  } else {
    // Card is USD: preserve exact plan price with decimals (19.99). Never ceil.
    fx = {
      baseCurrency: 'USD',
      baseAmountCents: baseCents,
      quoteCurrency: 'USD',
      rate: 1,
      rateDate: new Date().toISOString().slice(0, 10),
      source: 'identity',
      fetchedAt: new Date().toISOString(),
      localMajorUnits: chargeMajor,
      localMinorUnits: chargeMinor,
      minorDigits: 2,
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
  // Server-owned idempotency: never trust client keys for cross-user identity.
  // Client may send a short clientToken for same-user retry; it is namespaced by userId.
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

      // Material change: amount/currency/method must match the stored payment.
      // If the current quote differs, this is a new logical attempt — mint a fresh key.
      const storedMinor = Number(row.amount_cents);
      const storedCurrency = String(row.currency || '').toUpperCase();
      const storedMethod = String(row.method || '').toLowerCase();
      const quoteMatches =
        Number.isFinite(storedMinor) &&
        storedMinor === Number(quote.amountMinor) &&
        storedCurrency === String(quote.currency).toUpperCase() &&
        storedMethod === String(quote.method).toLowerCase();

      if (row.checkout_url && (row.status === 'pending' || row.status === 'processing') && quoteMatches) {
        await client.query('COMMIT');
        // Rebuild quote presentation from the immutable payment snapshot (not a fresh FX pull).
        const snap = row.fx_snapshot && typeof row.fx_snapshot === 'object' ? row.fx_snapshot : {};
        const replayQuote = {
          plan: quote.plan,
          method: storedMethod,
          currency: storedCurrency,
          amountMinor: storedMinor,
          amountMajor: snap.localMajorUnits != null
            ? Number(snap.localMajorUnits)
            : storedMinor / (snap.minorDigits != null ? 10 ** Number(snap.minorDigits) : 100),
          fxSnapshot: snap,
        };
        return {
          payment: paymentService.mapPayment(row),
          checkoutUrl: row.checkout_url,
          checkoutId: row.external_checkout_id,
          quote: replayQuote,
          replayed: true,
        };
      }
      if (row.status === 'completed' || row.status === 'approved') {
        await client.query('COMMIT');
        const err = new Error('Já existe um pagamento concluído para esta tentativa. Inicie um novo checkout.');
        err.code = 'ALREADY_PAID';
        throw err;
      }
      // Failed/expired/cancelled OR quote no longer matches: mint a fresh idempotency key
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
        key, null, // reference set to payment.id immediately after insert
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
      if (payment && String(payment.user_id) !== String(userId)) {
        await client.query('ROLLBACK');
        const err = new Error('Pagamento não pertence a este utilizador.');
        err.code = 'OWNERSHIP';
        throw err;
      }
    }
    if (payment && payment.id) {
      // Stable internal reference = payment UUID (never userId)
      await client.query(
        `UPDATE payments SET reference = $2
         WHERE id = $1 AND (reference IS NULL OR reference = $2 OR reference = $3)`,
        [payment.id, String(payment.id), String(userId)]
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
 * Official signature contract is unconfirmed. Reject all signatures
 * until PayZeno confirms the exact header, signed bytes, encoding and replay rules.
 */
function verifyWebhookSignature() {
  // Fail closed: the official PayZeno signature contract is not confirmed.
  // Never accept speculative HMAC formats for payment activation.
  return {
    ok: false,
    reason: 'SIGNATURE_CONTRACT_UNCONFIRMED',
    documented: false,
  };
}

async function recordWebhookEvent({ eventId, eventType, paymentId, payload, client }) {
  if (!eventId) return { inserted: false, eventRow: null };
  const db = client || getPool();
  try {
    const { rows } = await db.query(
      `INSERT INTO payment_webhook_events (provider, event_id, event_type, payment_id, payload, processing_status)
       VALUES ('payzeno',$1,$2,$3,$4::jsonb,'received')
       ON CONFLICT (provider, event_id) DO UPDATE SET
         payload = EXCLUDED.payload,
         event_type = COALESCE(EXCLUDED.event_type, payment_webhook_events.event_type),
         payment_id = COALESCE(EXCLUDED.payment_id, payment_webhook_events.payment_id)
       WHERE payment_webhook_events.processing_status IS DISTINCT FROM 'processed'
       RETURNING *`,
      [eventId, eventType || null, paymentId || null, JSON.stringify(payload || {})]
    );
    if (rows[0]) return { inserted: true, eventRow: rows[0], duplicate: false };
    // Already processed
    const existing = await db.query(
      `SELECT * FROM payment_webhook_events WHERE provider='payzeno' AND event_id=$1`,
      [eventId]
    );
    return {
      inserted: false,
      duplicate: true,
      processed: existing.rows[0] && existing.rows[0].processing_status === 'processed',
      eventRow: existing.rows[0] || null,
    };
  } catch (e) {
    if (e && e.code === '23505') {
      const existing = await db.query(
        `SELECT * FROM payment_webhook_events WHERE provider='payzeno' AND event_id=$1`,
        [eventId]
      );
      return {
        inserted: false,
        duplicate: true,
        processed: existing.rows[0] && existing.rows[0].processing_status === 'processed',
        eventRow: existing.rows[0] || null,
      };
    }
    throw e;
  }
}

async function markWebhookProcessed(eventId, client, status = 'processed', errorMessage = null) {
  if (!eventId) return;
  const db = client || getPool();
  await db.query(
    `UPDATE payment_webhook_events
     SET processing_status = $2,
         payload = CASE
           WHEN $3::text IS NULL THEN payload
           ELSE payload || jsonb_build_object('lastError', $3::text)
         END
     WHERE provider = 'payzeno' AND event_id = $1`,
    [eventId, status, errorMessage]
  );
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
 * Idempotency: event is only marked `processed` after successful completion.
 * A failed attempt leaves status `failed`/`received` so PayZeno retries can re-run.
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
  if (rec.duplicate && rec.processed) {
    return { ok: true, replayed: true, reason: 'duplicate_event_already_processed' };
  }

  try {
    let result;
    if (event === 'payment.succeeded' || status === 'succeeded' || status === 'paid') {
      result = await completePaymentFromGateway({
        paymentId: internalId,
        externalPaymentId,
        checkoutId,
        amount: payload.amount,
        currency: payload.currency,
        eventId: eventId || rec.eventRow && rec.eventRow.event_id,
        payload,
      });
    } else if (event === 'payment.refunded' || status === 'refunded') {
      result = await markPaymentTerminal({
        paymentId: internalId,
        checkoutId,
        externalPaymentId,
        nextStatus: 'refunded',
        payload,
      });
    } else if (event === 'payment.chargeback' || status === 'chargeback') {
      result = await markPaymentTerminal({
        paymentId: internalId,
        checkoutId,
        externalPaymentId,
        nextStatus: 'chargeback',
        payload,
      });
    } else {
      result = { ok: true, ignored: true, event, status };
    }
    await markWebhookProcessed(eventId || (rec.eventRow && rec.eventRow.event_id), null, 'processed');
    return result;
  } catch (err) {
    try {
      await markWebhookProcessed(
        eventId || (rec.eventRow && rec.eventRow.event_id),
        null,
        'failed',
        err && err.message
      );
    } catch (_) {}
    throw err;
  }
}

async function completePaymentFromGateway({
  paymentId, externalPaymentId, checkoutId, amount, currency, eventId, payload,
}) {
  if (!paymentId) {
    const err = new Error('Referência de pagamento em falta no webhook');
    err.code = 'NO_REFERENCE';
    throw err;
  }
  if (amount == null || amount === '') {
    const err = new Error('amount em falta no webhook de sucesso');
    err.code = 'MISSING_AMOUNT';
    throw err;
  }
  if (!currency) {
    const err = new Error('currency em falta no webhook de sucesso');
    err.code = 'MISSING_CURRENCY';
    throw err;
  }
  if (!checkoutId) {
    const err = new Error('checkout_id em falta no webhook de sucesso');
    err.code = 'MISSING_CHECKOUT_ID';
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

    if (!pay.external_checkout_id) {
      await client.query('ROLLBACK');
      const err = new Error('Pagamento interno sem checkout_id armazenado');
      err.code = 'MISSING_STORED_CHECKOUT';
      throw err;
    }
    if (String(pay.external_checkout_id) !== String(checkoutId)) {
      await client.query('ROLLBACK');
      const err = new Error('checkout_id não corresponde ao pagamento interno');
      err.code = 'CHECKOUT_MISMATCH';
      throw err;
    }
    if (Number(pay.amount_cents) !== Number(amount)) {
      await client.query('ROLLBACK');
      const err = new Error('Valor do webhook não corresponde ao pagamento');
      err.code = 'AMOUNT_MISMATCH';
      throw err;
    }
    if (String(pay.currency).toUpperCase() !== String(currency).toUpperCase()) {
      await client.query('ROLLBACK');
      const err = new Error('Moeda do webhook não corresponde ao pagamento');
      err.code = 'CURRENCY_MISMATCH';
      throw err;
    }
    if (
      pay.external_payment_id &&
      externalPaymentId &&
      String(pay.external_payment_id) !== String(externalPaymentId)
    ) {
      await client.query('ROLLBACK');
      const err = new Error('payment_id externo não corresponde');
      err.code = 'EXTERNAL_PAYMENT_MISMATCH';
      throw err;
    }

    const sub = await subscriptionService.activateSubscription({
      userId: pay.user_id,
      planId: pay.plan_id,
      source: 'gateway',
      externalRef: externalPaymentId || pay.external_checkout_id || pay.id,
      client,
    });

    await client.query(
      `UPDATE payments SET status='completed',
         subscription_id = $2,
         external_payment_id=COALESCE($3, external_payment_id),
         external_checkout_id=COALESCE($4, external_checkout_id),
         gateway_payload = gateway_payload || $5::jsonb,
         updated_at=NOW()
       WHERE id=$1`,
      [
        paymentId,
        sub && sub.id ? sub.id : null,
        externalPaymentId || null,
        checkoutId || null,
        JSON.stringify({ completedEvent: payload || {}, eventId: eventId || null }),
      ]
    );
    await client.query('COMMIT');
    const { rows: updated } = await pool.query(`SELECT * FROM payments WHERE id=$1`, [paymentId]);
    return { ok: true, replayed: false, payment: paymentService.mapPayment(updated[0]), subscription: sub };
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
    if (pay.status === nextStatus) {
      await client.query('COMMIT');
      return { ok: true, replayed: true, payment: paymentService.mapPayment(pay) };
    }
    // Do not let an older refund/chargeback undo a later completed payment's renewal
    // only touch the subscription linked to THIS payment.
    await client.query(
      `UPDATE payments SET status=$2,
         external_payment_id=COALESCE($3, external_payment_id),
         gateway_payload = gateway_payload || $4::jsonb,
         updated_at=NOW()
       WHERE id=$1`,
      [pay.id, nextStatus, externalPaymentId || null, JSON.stringify({ terminalEvent: payload || {} })]
    );
    if ((nextStatus === 'refunded' || nextStatus === 'chargeback') && pay.subscription_id) {
      await client.query(
        `UPDATE subscriptions SET status='cancelled', updated_at=NOW()
         WHERE id=$1 AND user_id=$2 AND status='active'`,
        [pay.subscription_id, pay.user_id]
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
  isDemoPaymentRow,
};
