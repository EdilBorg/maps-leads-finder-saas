const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const mig = fs.readFileSync(path.join(root, 'migrations/018_pro_plan_lead_quota_fx_payzeno.sql'), 'utf8');
const billing = fs.readFileSync(path.join(root, 'src/routes/billing.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const front = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const fx = require('../src/services/fxRateService');
const payzeno = require('../src/services/payzenoService');

describe('migration 018 Pro plan', () => {
  it('inserts Pro 1999/2500 idempotently', () => {
    assert.match(mig, /'Pro'/);
    assert.match(mig, /1999/);
    assert.match(mig, /2500/);
    assert.match(mig, /ON CONFLICT \(name\)/);
    assert.match(mig, /fx_rates/);
    assert.match(mig, /payment_webhook_events/);
  });
});

describe('billing routes', () => {
  it('exposes plans, manual payment, checkout, webhook', () => {
    assert.match(billing, /router\.get\('\/plans'/);
    assert.match(billing, /checkout\/session/);
    assert.match(billing, /router\.post\('\/checkout\/session'/);
    assert.match(billing, /router\.post\('\/webhooks\/payzeno'/);
  });
  it('app mounts raw body for webhook before json', () => {
    const raw = appJs.indexOf('payzenoRawBody');
    const json = appJs.indexOf("express.json");
    assert.ok(raw > 0 && raw < json);
  });
});

describe('FX and PayZeno unit', () => {
  it('ceil converts USD cents to local minor units with BigInt', () => {
    // 19.99 * 1322.8 = 26442.772 → ceil to minor (2 digits) = 26442.78 → 2644278
    const r = fx.convertUsdCentsToLocal(1999, 1322.8, { minorFactor: 100 });
    assert.equal(r.minorUnits, 2644278);
    assert.equal(r.majorUnits, 26442.78);
    assert.equal(r.minorDigits, 2);
  });
  it('webhook HMAC remains fail-closed until official contract', () => {
    const secret = 'test-secret';
    const raw = '{"status":"completed"}';
    const ts = '1';
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
    // Speculative formats must not be accepted
    assert.equal(payzeno.verifyWebhookSignature({ rawBody: raw, signature: sig, timestamp: ts, secret }).ok, false);
    assert.equal(payzeno.verifyWebhookSignature({ rawBody: raw, signature: '00', timestamp: ts, secret }).ok, false);
    assert.equal(payzeno.verifyWebhookSignature().reason, 'SIGNATURE_CONTRACT_UNCONFIRMED');
  });
  it('maps methods to currencies', () => {
    assert.equal(payzeno.methodCurrency('mpesa'), 'MZN');
    assert.equal(payzeno.methodCurrency('card'), 'USD');
  });
});

describe('frontend plans page', () => {
  it('loads sections independently and has subscribe actions', () => {
    assert.match(front, /loadPlansQuotaViewBody/);
    assert.match(front, /openSubscribeModal/);
    assert.match(front, /Assinar \/ Renovar|subscribe-pay-btn/);
    assert.match(front, /Promise\.all/);
    assert.match(front, /\/api\/billing\/checkout\/session/);
  });
});
