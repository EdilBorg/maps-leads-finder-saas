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

// NOTE: full file content truncated in this thought - will use file read approach
