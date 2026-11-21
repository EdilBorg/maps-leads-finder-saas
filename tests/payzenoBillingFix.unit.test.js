const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const payzenoSrc = fs.readFileSync(path.join(root, 'src/services/payzenoService.js'), 'utf8');
const paymentSrc = fs.readFileSync(path.join(root, 'src/services/paymentService.js'), 'utf8');
const billingSrc = fs.readFileSync(path.join(root, 'src/routes/billing.js'), 'utf8');
const adminSrc = fs.readFileSync(path.join(root, 'src/routes/admin.js'), 'utf8');
const mig019 = fs.readFileSync(path.join(root, 'migrations/019_webhook_processing_status.sql'), 'utf8');
const payzeno = require('../src/services/payzenoService');

describe('payment method storage', () => {
  it('INSERT uses quote.method not literal gateway', () => {
    assert.ok(!/VALUES \(\$1,\$2,\$3,\$4,'gateway'/.test(payzenoSrc));
    assert.match(payzenoSrc, /quote\.method/);
    // VALUES position for method is $5 bound to quote.method
    assert.match(payzenoSrc, /VALUES \(\$1,\$2,\$3,\$4,\$5,'pending'/);
  });
});

describe('manual payment removed from services and routes', () => {
  it('paymentService has no manual APIs', () => {
    assert.ok(!/createManualPayment|approvePayment|rejectPayment|listPendingPayments/.test(paymentSrc));
    assert.match(paymentSrc, /listPaymentsForUser/);
    assert.match(paymentSrc, /mapPayment/);
  });
  it('billing has no POST /payments', () => {
    assert.ok(!/router\.post\(\s*'\/payments'/.test(billingSrc));
    assert.ok(!/manualEnabled/.test(billingSrc));
  });
  it('admin has no approve/reject/pending payment routes', () => {
    assert.ok(!/payments\/:id\/approve|payments\/:id\/reject|payments\/pending/.test(adminSrc));
  });
});

describe('webhook idempotency design', () => {
  it('tracks processing_status and only marks processed after success', () => {
    assert.match(payzenoSrc, /processing_status/);
    assert.match(payzenoSrc, /markWebhookProcessed/);
    assert.match(payzenoSrc, /'processed'/);
    assert.match(payzenoSrc, /'failed'/);
    assert.match(mig019, /processing_status/);
  });
  it('records event before process but allows retry when not processed', () => {
    assert.match(payzenoSrc, /WHERE payment_webhook_events\.processing_status IS DISTINCT FROM 'processed'/);
    assert.match(payzenoSrc, /duplicate_event_already_processed/);
  });
});

describe('strict payment validation', () => {
  it('requires amount currency checkout_id', () => {
    assert.match(payzenoSrc, /MISSING_AMOUNT/);
    assert.match(payzenoSrc, /MISSING_CURRENCY/);
    assert.match(payzenoSrc, /MISSING_CHECKOUT_ID/);
    assert.match(payzenoSrc, /AMOUNT_MISMATCH/);
    assert.match(payzenoSrc, /CURRENCY_MISMATCH/);
    assert.match(payzenoSrc, /CHECKOUT_MISMATCH/);
  });
});

describe('refund/chargeback scoped to payment subscription', () => {
  it('cancels only pay.subscription_id not all plan subscriptions', () => {
    assert.match(payzenoSrc, /pay\.subscription_id/);
    assert.ok(!/WHERE user_id=\$1 AND plan_id=\$2 AND status='active' AND source='gateway'/.test(payzenoSrc));
    assert.match(payzenoSrc, /WHERE id=\$1 AND user_id=\$2 AND status='active'/);
  });
  it('links subscription_id on complete', () => {
    assert.match(payzenoSrc, /subscription_id = \$2/);
  });
});

describe('HMAC verification (contract not officially documented)', () => {
  it('fails closed until the official signature contract is confirmed', () => {
    const secret = 'whsec_test';
    const raw = JSON.stringify({
      event: 'payment.succeeded',
      status: 'succeeded',
      amount: 1999,
      currency: 'USD',
      checkout_id: 'c1',
      reference: 'p1',
    });
    assert.equal(payzeno.verifyWebhookSignature({ rawBody: raw, signature: 'aa', secret }).ok, false);
    assert.equal(payzeno.verifyWebhookSignature({ rawBody: raw, signature: '', secret }).ok, false);
    assert.equal(payzeno.verifyWebhookSignature({ rawBody: raw, signature: 'x' }).ok, false);
    const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const result = payzeno.verifyWebhookSignature({ rawBody: raw, signature: sig, secret });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'SIGNATURE_CONTRACT_UNCONFIRMED');
  });
  it('documents that official HMAC contract is unconfirmed', () => {
    assert.match(payzenoSrc, /documented: false|not document|OpenAPI does not document/i);
  });
});

describe('method allowlist', () => {
  it('maps only known methods', () => {
    assert.equal(payzeno.methodCurrency('mpesa'), 'MZN');
    assert.equal(payzeno.methodCurrency('emola'), 'MZN');
    assert.equal(payzeno.methodCurrency('card'), 'USD');
    assert.equal(payzeno.methodCurrency('unknown_xyz'), null);
  });
});
