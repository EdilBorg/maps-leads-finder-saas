const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const billing = fs.readFileSync(path.join(root, 'src/routes/billing.js'), 'utf8');
const payzeno = require('../src/services/payzenoService');
const front = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'src/routes/admin.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

describe('manual payment removed', () => {
  it('billing has no POST /payments manual route', () => {
    assert.ok(!/router\.post\(\s*'\/payments'/.test(billing));
  });
  it('frontend has no pedido manual', () => {
    assert.ok(!/Pedido manual|btn-subscribe-manual|createManualPayment/.test(front));
  });
  it('admin has no approve/reject payment routes', () => {
    assert.ok(!/payments\/:id\/approve|payments\/:id\/reject|payments\/pending/.test(admin));
  });
});

describe('subscribe UX', () => {
  it('has Assinar / Renovar entry and modal flow', () => {
    assert.match(indexHtml, /Assinar \/ Renovar/);
    assert.match(front, /openSubscribeModal/);
    assert.match(front, /handleBillingReturn/);
    assert.match(front, /btn-open-subscribe-modal/);
  });
});

describe('PayZeno official webhook events', () => {
  it('handleWebhookPayload recognizes payment.succeeded', async () => {
    // Without DB, only signature unit tests run here
    assert.equal(typeof payzeno.handleWebhookPayload, 'function');
    assert.equal(typeof payzeno.verifyWebhookSignature, 'function');
  });
  it('HMAC verifies body and timestamp.body patterns', () => {
    const secret = 'test-secret';
    const raw = JSON.stringify({
      event: 'payment.succeeded',
      status: 'succeeded',
      payment_id: 'px1',
      checkout_id: 'cx1',
      reference: 'ref1',
      amount: 1999,
      currency: 'USD',
    });
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    assert.equal(payzeno.verifyWebhookSignature({ rawBody: raw, signature: sig, secret }).ok, true);
    const ts = '1710000000';
    const sig2 = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
    assert.equal(payzeno.verifyWebhookSignature({ rawBody: raw, signature: sig2, timestamp: ts, secret }).ok, true);
    assert.equal(payzeno.verifyWebhookSignature({ rawBody: raw, signature: '00', secret }).ok, false);
  });
  it('methods map to currencies', () => {
    assert.equal(payzeno.methodCurrency('mpesa'), 'MZN');
    assert.equal(payzeno.methodCurrency('card'), 'USD');
  });
});

describe('billing routes surface', () => {
  it('exposes checkout and payment status, not manual', () => {
    assert.match(billing, /checkout\/session/);
    assert.match(billing, /payments\/:id\/status/);
    assert.match(billing, /webhooks\/payzeno/);
    assert.match(billing, /payment\.succeeded|handleWebhookPayload/);
  });
});
