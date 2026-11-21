const express = require('express');
const { requireAuth, requireVerifiedEmail } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const quotaService = require('../services/quotaService');
const planService = require('../services/planService');
const subscriptionService = require('../services/subscriptionService');
const paymentService = require('../services/paymentService');

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
        maxResultsPerSearch: p.maxResultsPerSearch, maxResultsPerMonth: p.maxResultsPerMonth, features: p.features,
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

module.exports = router;
