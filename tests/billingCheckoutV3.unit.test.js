
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const front = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const billingSrc = fs.readFileSync(path.join(root, 'src/routes/billing.js'), 'utf8');
const pzSrc = fs.readFileSync(path.join(root, 'src/services/payzenoService.js'), 'utf8');
const fx = require('../src/services/fxRateService');
const payzeno = require('../src/services/payzenoService');

describe('checkout UI v3 compact', () => {
  it('shows PRO and $19.99 without feature list', () => {
    assert.match(front, /checkout-pro-header/);
    assert.match(front, /\$19\.99/);
    assert.match(front, /checkout-methods-grid/);
    assert.match(front, /checkout-method-card/);
    // Checkout modal itself uses compact header (plan features remain on the plans page card only)
    assert.match(front, /checkout-price/);
    assert.match(front, /Continuar para pagamento/);
  });
  it('uses provided payment logos', () => {
    assert.match(front, /\/img\/payments\/mpesa\.jpeg/);
    assert.match(front, /\/img\/payments\/emola\.jpeg/);
    assert.match(front, /\/img\/payments\/card\.jpeg/);
    assert.match(front, /\/img\/payments\/payfast\.jpeg/);
    assert.match(front, /\/img\/payments\/multicaixa\.jpeg/);
  });
  it('stable idempotency token per attempt', () => {
    assert.match(front, /getOrCreateAttemptToken/);
    assert.match(front, /billingAttempt:/);
  });
});

describe('checkout idempotency key namespaced by user', () => {
  it('builds server key with user plan method token', () => {
    assert.match(pzSrc, /payzeno:u:\$\{userId\}:p:\$\{planId\}:m:\$\{quote\.method\}:t:\$\{clientToken\}/);
  });
});

describe('payment reference is payment id not userId', () => {
  it('sets reference to String(payment.id)', () => {
    assert.match(pzSrc, /payment\.reference = String\(payment\.id\)/);
    // insert uses null, not String(userId) as permanent reference
    assert.match(pzSrc, /null, \/\/ reference set to payment\.id/);
  });
});

describe('return URLs server-owned', () => {
  it('does not accept client successUrl/cancelUrl', () => {
    assert.ok(!/req\.body && req\.body\.successUrl/.test(billingSrc));
    assert.ok(!/req\.body && req\.body\.cancelUrl/.test(billingSrc));
    assert.match(billingSrc, /APP_URL/);
    assert.match(billingSrc, /billing=return/);
    assert.match(billingSrc, /billing=cancel/);
  });
});

describe('FX precision and safety', () => {
  it('converts 19.99 USD correctly', () => {
    const r = fx.convertUsdCentsToLocal(1999, 63.5, { currency: 'MZN' });
    assert.equal(r.minorUnits, 126937);
    assert.equal(r.minorDigits, 2);
  });
  it('rejects unknown currency', () => {
    assert.throws(() => fx.convertUsdCentsToLocal(100, 1, { currency: 'XXX' }), (e) => e.code === 'CURRENCY_UNSUPPORTED');
  });
  it('rejects overflow beyond MAX_SAFE_INTEGER', () => {
    // huge rate to force overflow
    assert.throws(
      () => fx.convertUsdCentsToLocal(Number.MAX_SAFE_INTEGER, 1e10, { currency: 'USD' }),
      (e) => e && (e.code === 'FX_OVERFLOW' || e.code === 'FX_INVALID')
    );
  });
});

describe('webhook remains fail-closed', () => {
  it('signature contract unconfirmed', () => {
    const v = payzeno.verifyWebhookSignature({
      rawBody: '{}',
      signature: 'abc',
      timestamp: '1',
      secret: 's',
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'SIGNATURE_CONTRACT_UNCONFIRMED');
  });
});
