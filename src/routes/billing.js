const express = require('express');
const { requireAuth, requireVerifiedEmail } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const quotaService = require('../services/quotaService');
const planService = require('../services/planService');
const subscriptionService = require('../services/subscriptionService');
const paymentService = require('../services/paymentService');
const payzenoService = require('../services/payzenoService');

const router = express.Router();

router.get('/quota', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const view = await quotaService.getClientQuotaView(req.session.userId);
    res.json({ ok: true, ...view });
  } catch (err) { next(err); }
});

router.get('/plans', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const plans = await planService.listPlans({ activeOnly: true });
    res.json({
      ok: true,
      plans: plans.map((p) => ({
        id: p.id, name: p.name, description: p.description,
        priceCents: p.priceCents, currency: p.currency,
        maxResultsPerSearch: p.maxResultsPerSearch,
        maxResultsPerMonth: p.maxResultsPerMonth,
        maxSearchesPerMonth: p.maxSearchesPerMonth,
        features: p.features,
        isActive: p.isActive,
      })),
    });
  } catch (err) { next(err); }
});

router.get('/subscription', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const sub = await subscriptionService.getActiveSubscription(req.session.userId);
    const history = await subscriptionService.listSubscriptionsForUser(req.session.userId);
    res.json({ ok: true, active: sub, history });
  } catch (err) { next(err); }
});

router.get('/payments', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    res.json({ ok: true, payments: await paymentService.listPaymentsForUser(req.session.userId) });
  } catch (err) { next(err); }
});

router.post('/payments', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    const planId = req.body && req.body.planId;
    if (!planId) return res.status(400).json({ ok: false, error: 'planId obrigatório' });
    const plan = await planService.getPlanById(planId);
    if (!plan || !plan.isActive) return res.status(404).json({ ok: false, error: 'Plano não encontrado' });
    const result = await paymentService.createManualPayment({
      userId: req.session.userId,
      planId,
      amountCents: plan.priceCents,
      currency: plan.currency,
      reference: (req.body && req.body.reference) || null,
      proofUrl: (req.body && req.body.proofUrl) || null,
      idempotencyKey: (req.body && req.body.idempotencyKey) || null,
    });
    res.status(201).json({ ok: true, payment: result.payment, replayed: result.replayed });
  } catch (err) { next(err); }
});

router.get('/payment-methods', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const methods = payzenoService.allowedMethods().map((code) => ({
      code,
      currency: payzenoService.methodCurrency(code),
    }));
    res.json({
      ok: true,
      methods,
      gatewayConfigured: Boolean(process.env.PAYZENO_API_KEY),
      manualEnabled: true,
    });
  } catch (err) { next(err); }
});

router.post('/checkout/quote', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    const planId = req.body && req.body.planId;
    const method = req.body && req.body.method;
    if (!planId || !method) return res.status(400).json({ ok: false, error: 'planId e method são obrigatórios' });
    const quote = await payzenoService.buildCheckoutQuote({ planId, method });
    res.json({
      ok: true,
      planId: quote.plan.id,
      planName: quote.plan.name,
      method: quote.method,
      currency: quote.currency,
      amountMajor: quote.amountMajor,
      amountMinor: quote.amountMinor,
      fx: quote.fxSnapshot,
      referencePrice: { amountCents: quote.plan.priceCents, currency: quote.plan.currency },
    });
  } catch (err) {
    if (['FX_UNAVAILABLE', 'METHOD_NOT_ALLOWED', 'PLAN_NOT_FOUND', 'CURRENCY_UNSUPPORTED'].includes(err.code)) {
      return res.status(400).json({ ok: false, error: err.message, code: err.code });
    }
    next(err);
  }
});

router.post('/checkout/session', requireAuth, requireVerifiedEmail, requireCsrf, async (req, res, next) => {
  try {
    const planId = req.body && req.body.planId;
    const method = req.body && req.body.method;
    const customer = (req.body && req.body.customer) || {};
    if (!planId || !method) return res.status(400).json({ ok: false, error: 'planId e method são obrigatórios' });
    if (!customer.name || !customer.phone) {
      return res.status(400).json({ ok: false, error: 'Nome e telefone (E.164) são obrigatórios para o checkout.' });
    }
    const appUrl = process.env.APP_URL || '';
    const result = await payzenoService.createCheckoutSession({
      userId: req.session.userId,
      planId,
      method,
      customer: {
        name: String(customer.name).trim(),
        phone: String(customer.phone).trim(),
        email: customer.email || undefined,
      },
      successUrl: (req.body && req.body.successUrl) || (appUrl + '/?billing=success'),
      cancelUrl: (req.body && req.body.cancelUrl) || (appUrl + '/?billing=cancel'),
      idempotencyKey: (req.body && req.body.idempotencyKey) || null,
    });
    res.status(201).json({
      ok: true,
      payment: result.payment,
      checkoutUrl: result.checkoutUrl,
      checkoutId: result.checkoutId,
      quote: {
        currency: result.quote.currency,
        amountMajor: result.quote.amountMajor,
        amountMinor: result.quote.amountMinor,
        fx: result.quote.fxSnapshot,
      },
      replayed: result.replayed,
    });
  } catch (err) {
    if (['FX_UNAVAILABLE', 'METHOD_NOT_ALLOWED', 'PLAN_NOT_FOUND', 'PAYZENO_NOT_CONFIGURED', 'PAYZENO_UNCERTAIN', 'PAYZENO_HTTP'].includes(err.code)) {
      return res.status(err.code === 'PAYZENO_NOT_CONFIGURED' ? 503 : 400).json({
        ok: false, error: err.message, code: err.code, paymentId: err.paymentId,
      });
    }
    next(err);
  }
});

router.post('/webhooks/payzeno', async (req, res, next) => {
  try {
    const secret = process.env.PAYZENO_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ ok: false, error: 'Webhook não configurado' });
    const rawBody = req.payzenoRawBody || (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null);
    if (!rawBody) return res.status(400).json({ ok: false, error: 'Raw body em falta' });
    const signature = req.get('x-payzeno-signature') || req.get('X-PayZeno-Signature') || req.get('x-signature') || '';
    const timestamp = req.get('x-payzeno-timestamp') || req.get('X-PayZeno-Timestamp') || req.get('x-timestamp') || '';
    const ver = payzenoService.verifyWebhookSignature({ rawBody, signature, timestamp, secret });
    if (!ver.ok) return res.status(401).json({ ok: false, error: 'Assinatura inválida', reason: ver.reason });
    let payload;
    try { payload = JSON.parse(rawBody); } catch (_) {
      return res.status(400).json({ ok: false, error: 'JSON inválido' });
    }
    const eventId = payload.id || payload.event_id || payload.eventId;
    const status = String((payload.status || (payload.data && payload.data.status) || '')).toLowerCase();
    const paymentId = (payload.metadata && payload.metadata.payment_id)
      || payload.reference
      || (payload.data && payload.data.reference);
    const externalPaymentId = payload.payment_id || payload.paymentId || (payload.data && payload.data.id);
    if (!paymentId) return res.status(202).json({ ok: true, ignored: true, reason: 'no_payment_ref' });
    if (status === 'completed' || status === 'paid' || status === 'success' || payload.type === 'checkout.completed') {
      const result = await payzenoService.completePaymentFromGateway({
        paymentId, externalPaymentId, eventId, payload,
      });
      return res.json({ ok: true, replayed: !!result.replayed });
    }
    if (eventId) {
      try {
        await require('../db/pool').getPool().query(
          `INSERT INTO payment_webhook_events (provider, event_id, event_type, payment_id, payload)
           VALUES ('payzeno',$1,$2,$3,$4::jsonb) ON CONFLICT (provider, event_id) DO NOTHING`,
          [eventId, payload.type || status, paymentId, JSON.stringify(payload)]
        );
      } catch (_) {}
    }
    return res.json({ ok: true, ignored: true, status });
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ ok: false, error: err.message });
    next(err);
  }
});

module.exports = router;
