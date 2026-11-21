const express = require('express');
const { requireAuth, requireVerifiedEmail } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const quotaService = require('../services/quotaService');
const planService = require('../services/planService');
const subscriptionService = require('../services/subscriptionService');
const paymentService = require('../services/paymentService');
const payzenoService = require('../services/payzenoService');
const authService = require('../services/authService');

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

/** Ownership-checked payment status (never activates from client). */
router.get('/payments/:id/status', requireAuth, requireVerifiedEmail, async (req, res, next) => {
  try {
    const payment = await payzenoService.getPaymentForUser(req.session.userId, req.params.id);
    if (!payment) return res.status(404).json({ ok: false, error: 'Pagamento não encontrado' });
    let remote = null;
    if (payment.status === 'pending' && payment.externalCheckoutId) {
      remote = await payzenoService.fetchRemoteSessionStatus(payment.externalCheckoutId);
    }
    res.json({ ok: true, payment, remote });
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
    if (!planId || !method) return res.status(400).json({ ok: false, error: 'planId e method são obrigatórios' });

    const user = await authService.findUserById(req.session.userId);
    let name = (req.body.customer && req.body.customer.name) || (user && user.name) || '';
    let email = (req.body.customer && req.body.customer.email) || (user && user.email) || '';
    let phone = (req.body.customer && req.body.customer.phone) || (user && user.phone) || '';
    name = String(name || '').trim();
    phone = String(phone || '').trim();
    email = String(email || '').trim();
    if (!name || !phone) {
      return res.status(400).json({
        ok: false,
        error: 'Nome e telefone (E.164) são obrigatórios para o checkout PayZeno.',
        code: 'CUSTOMER_REQUIRED',
      });
    }

    const appUrl = process.env.APP_URL || '';
    const result = await payzenoService.createCheckoutSession({
      userId: req.session.userId,
      planId,
      method,
      customer: { name, phone, email: email || undefined },
      successUrl: (req.body && req.body.successUrl) || `${appUrl}/?billing=return`,
      cancelUrl: (req.body && req.body.cancelUrl) || `${appUrl}/?billing=cancel`,
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
    if ([
      'FX_UNAVAILABLE', 'METHOD_NOT_ALLOWED', 'PLAN_NOT_FOUND', 'PAYZENO_NOT_CONFIGURED',
      'PAYZENO_UNCERTAIN', 'PAYZENO_HTTP', 'PAYZENO_NO_URL', 'ALREADY_PAID',
    ].includes(err.code)) {
      const code = err.code === 'PAYZENO_NOT_CONFIGURED' ? 503 : 400;
      return res.status(code).json({
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
    const signature =
      req.get('x-payzeno-signature') ||
      req.get('X-PayZeno-Signature') ||
      req.get('payzeno-signature') ||
      req.get('x-signature') ||
      '';
    const timestamp =
      req.get('x-payzeno-timestamp') ||
      req.get('X-PayZeno-Timestamp') ||
      req.get('x-timestamp') ||
      '';
    const ver = payzenoService.verifyWebhookSignature({ rawBody, signature, timestamp, secret });
    if (!ver.ok) {
      return res.status(401).json({
        ok: false,
        error: 'Assinatura inválida',
        reason: ver.reason,
        signatureContractDocumented: false,
      });
    }
    let payload;
    try { payload = JSON.parse(rawBody); } catch (_) {
      return res.status(400).json({ ok: false, error: 'JSON inválido' });
    }
    const result = await payzenoService.handleWebhookPayload(payload);
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (['NOT_FOUND', 'NO_REFERENCE', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'CHECKOUT_MISMATCH', 'INVALID_STATE'].includes(err.code)) {
      return res.status(400).json({ ok: false, error: err.message, code: err.code });
    }
    next(err);
  }
});

module.exports = router;
