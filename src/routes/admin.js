const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const planService = require('../services/planService');
const subscriptionService = require('../services/subscriptionService');
const paymentService = require('../services/paymentService');
const providerUsageService = require('../services/providerUsageService');
const { getPool } = require('../db/pool');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/plans', async (req, res, next) => {
  try {
    const plans = await planService.listPlans({ activeOnly: false });
    const withLimits = [];
    for (const p of plans) withLimits.push(await planService.getPlanById(p.id));
    res.json({ ok: true, plans: withLimits });
  } catch (err) { next(err); }
});

router.post('/plans', requireCsrf, async (req, res, next) => {
  try {
    res.status(201).json({ ok: true, plan: await planService.createPlan(req.body || {}) });
  } catch (err) { next(err); }
});

router.patch('/plans/:id', requireCsrf, async (req, res, next) => {
  try {
    const plan = await planService.updatePlan(req.params.id, req.body || {});
    if (!plan) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, plan });
  } catch (err) { next(err); }
});

router.put('/plans/:id/limits/:provider', requireCsrf, async (req, res, next) => {
  try {
    const limit = await planService.upsertProviderLimit(req.params.id, req.params.provider, {
      maxResultsPerPeriod: req.body.maxResultsPerPeriod,
      maxCostMicroUsdPerPeriod: req.body.maxCostMicroUsdPerPeriod,
      maxApiCallsPerPeriod: req.body.maxApiCallsPerPeriod,
    });
    res.json({ ok: true, limit });
  } catch (err) { next(err); }
});

router.get('/payments/pending', async (req, res, next) => {
  try {
    res.json({ ok: true, payments: await paymentService.listPendingPayments() });
  } catch (err) { next(err); }
});

router.post('/payments/:id/approve', requireCsrf, async (req, res, next) => {
  try {
    const result = await paymentService.approvePayment(req.params.id, req.session.userId);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/payments/:id/reject', requireCsrf, async (req, res, next) => {
  try {
    const result = await paymentService.rejectPayment(
      req.params.id, req.session.userId, (req.body && req.body.reason) || null
    );
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/subscriptions/:userId/activate', requireCsrf, async (req, res, next) => {
  try {
    const planId = req.body && req.body.planId;
    if (!planId) return res.status(400).json({ ok: false, error: 'planId required' });
    const sub = await subscriptionService.activateSubscription({
      userId: req.params.userId, planId, source: 'manual',
    });
    await getPool().query(
      `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)\n       VALUES ($1,'subscription.activate','subscription',$2,$3::jsonb)`,
      [req.session.userId, sub.id, JSON.stringify({ userId: req.params.userId, planId })]
    );
    res.json({ ok: true, subscription: sub });
  } catch (err) { next(err); }
});

router.post('/subscriptions/:id/cancel', requireCsrf, async (req, res, next) => {
  try {
    const userId = req.body && req.body.userId;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });
    res.json({ ok: true, subscription: await subscriptionService.cancelSubscription(req.params.id, userId) });
  } catch (err) { next(err); }
});

router.get('/usage/:userId', async (req, res, next) => {
  try {
    const sub = await subscriptionService.getActiveSubscription(req.params.userId);
    if (!sub) return res.json({ ok: true, subscription: null, usage: [] });
    const period = subscriptionService.resolvePeriodWindow(sub, new Date());
    if (!period) return res.json({ ok: true, subscription: sub, usage: [] });
    const usage = await providerUsageService.getUserUsageSummary(req.params.userId, period.periodStart);
    res.json({ ok: true, subscription: sub, period, usage });
  } catch (err) { next(err); }
});

router.get('/settings/tomtom-quota', async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await providerUsageService.getTomTomGlobalConfig()) });
  } catch (err) { next(err); }
});

router.put('/settings/tomtom-quota', requireCsrf, async (req, res, next) => {
  try {
    const body = req.body || {};
    let maxCalls = null;
    if (body.maxCallsPerPeriod != null && body.maxCallsPerPeriod !== '') {
      const n = Number(body.maxCallsPerPeriod);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return res.status(400).json({
          ok: false,
          error: 'maxCallsPerPeriod deve ser inteiro >= 0 ou null (ilimitado)',
        });
      }
      // 0 means zero allowance (deny all); null means unlimited
      maxCalls = n;
    }
    let periodDays = 30;
    if (body.periodDays != null && body.periodDays !== '') {
      const d = Number(body.periodDays);
      if (!Number.isFinite(d) || !Number.isInteger(d) || d < 1 || d > 366) {
        return res.status(400).json({
          ok: false,
          error: 'periodDays deve ser inteiro entre 1 e 366',
        });
      }
      periodDays = d;
    }
    const value = {
      max_calls_per_period: maxCalls,
      period_days: periodDays,
      note: 'Configured by admin',
    };
    await getPool().query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('tomtom_global_quota', $1::jsonb, NOW())\n       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(value)]
    );
    res.json({ ok: true, config: value });
  } catch (err) { next(err); }
});

router.get('/pricing', async (req, res, next) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM provider_pricing ORDER BY provider_code, effective_from DESC`
    );
    res.json({ ok: true, pricing: rows });
  } catch (err) { next(err); }
});

router.post('/pricing', requireCsrf, async (req, res, next) => {
  try {
    const b = req.body || {};
    const allowed = ['apify', 'brightdata', 'tomtom'];
    if (!b.providerCode || !allowed.includes(String(b.providerCode))) {
      return res.status(400).json({ ok: false, error: 'providerCode inválido' });
    }
    if (!b.pricingVersion || typeof b.pricingVersion !== 'string' || !b.pricingVersion.trim()) {
      return res.status(400).json({ ok: false, error: 'pricingVersion obrigatório' });
    }
    const unit = b.unitCostMicroUsd;
    const fixed = b.fixedExecutionCostMicroUsd != null ? b.fixedExecutionCostMicroUsd : 0;
    if (unit == null || !Number.isInteger(Number(unit)) || Number(unit) < 0) {
      return res.status(400).json({ ok: false, error: 'unitCostMicroUsd deve ser inteiro >= 0 (micro-USD)' });
    }
    if (!Number.isInteger(Number(fixed)) || Number(fixed) < 0) {
      return res.status(400).json({ ok: false, error: 'fixedExecutionCostMicroUsd deve ser inteiro >= 0' });
    }
    if (String(unit).includes('.') || String(fixed).includes('.')) {
      return res.status(400).json({ ok: false, error: 'Custos devem ser inteiros micro-USD, sem decimais' });
    }
    const { rows } = await getPool().query(
      `INSERT INTO provider_pricing (
         provider_code, pricing_version, unit_cost_micro_usd,
         fixed_execution_cost_micro_usd, notes, active
       ) VALUES ($1,$2,$3,$4,$5,TRUE)
       ON CONFLICT (provider_code, pricing_version) DO UPDATE SET
         unit_cost_micro_usd = EXCLUDED.unit_cost_micro_usd,
         fixed_execution_cost_micro_usd = EXCLUDED.fixed_execution_cost_micro_usd,
         notes = EXCLUDED.notes, active = TRUE
       RETURNING *`,
      [b.providerCode, String(b.pricingVersion).trim(), Number(unit), Number(fixed), b.notes || null]
    );
    res.status(201).json({ ok: true, pricing: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
