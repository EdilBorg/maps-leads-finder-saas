'use strict';
/**
 * Demo payment simulation has been removed.
 * These tests lock that removal and the remaining real-checkout behaviour.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pzSrc = fs.readFileSync(path.join(root, 'src/services/payzenoService.js'), 'utf8');
const billingSrc = fs.readFileSync(path.join(root, 'src/routes/billing.js'), 'utf8');
const front = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const payzeno = require('../src/services/payzenoService');

describe('demo payment system removed', () => {
  it('does not export demo helpers', () => {
    assert.equal(typeof payzeno.isBillingDemoMode, 'undefined');
    assert.equal(typeof payzeno.confirmDemoPayment, 'undefined');
    assert.equal(typeof payzeno.cancelDemoPayment, 'undefined');
  });

  it('has no finalizeDemoCheckout or BILLING_DEMO_MODE branch', () => {
    assert.ok(!/finalizeDemoCheckout/.test(pzSrc));
    assert.ok(!/BILLING_DEMO_MODE/.test(pzSrc));
    assert.ok(!/isBillingDemoMode/.test(pzSrc));
    assert.ok(!/confirmDemoPayment/.test(pzSrc));
    assert.ok(!/cancelDemoPayment/.test(pzSrc));
  });

  it('has no demo routes', () => {
    assert.ok(!/\/demo\/confirm/.test(billingSrc));
    assert.ok(!/\/demo\/cancel/.test(billingSrc));
    assert.ok(!/demoPaymentOps/.test(billingSrc));
  });

  it('frontend has no demo checkout panel or simulated confirm', () => {
    assert.ok(!/showDemoCheckoutPanel/.test(front));
    assert.ok(!/__billingDemoMode/.test(front));
    assert.ok(!/\/api\/billing\/demo\//.test(front));
    assert.ok(!/MODO DE DEMONSTRAÇÃO/.test(front));
  });

  it('webhook remains fail-closed until official HMAC contract', () => {
    assert.match(pzSrc, /SIGNATURE_CONTRACT_UNCONFIRMED/);
  });
});

describe('subscribe modal opens without API key', () => {
  it('does not early-return on missing gateway', () => {
    // Premature block must be gone
    assert.ok(!/Checkout PayZeno não configurado no servidor/.test(front));
    assert.match(front, /openSubscribeModal/);
    assert.match(front, /\/api\/billing\/checkout\/quote/);
    assert.match(front, /\/api\/billing\/checkout\/session/);
  });

  it('surfaces PAYZENO_NOT_CONFIGURED only on checkout attempt', () => {
    assert.match(front, /PAYZENO_NOT_CONFIGURED/);
    assert.match(front, /Pagamentos automáticos não estão configurados/);
  });
});

describe('subscription UX and nav', () => {
  it('removes only Results nav item', () => {
    assert.ok(!/data-view="results">Resultados/.test(html));
    assert.match(html, /id="view-results"/);
    assert.match(html, /data-view="plans"/);
    assert.match(html, /Assinar \/ Renovar/);
  });
  it('subscription redesign markers present', () => {
    assert.match(html, /billing-page-header/);
    assert.match(front, /billing-card-pro|Activar Plano Pro/);
    assert.match(front, /Renovar Pro|Assinar Pro|Reactivar Pro|Activar Plano Pro/);
  });
});
