'use strict';
/**
 * Renewal + dark-theme + post-demo-removal guards.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const subSrc = fs.readFileSync(path.join(root, 'src/services/subscriptionService.js'), 'utf8');
const pzSrc = fs.readFileSync(path.join(root, 'src/services/payzenoService.js'), 'utf8');
const front = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/billing.css'), 'utf8')
  + fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');
const payzeno = require('../src/services/payzenoService');
const fx = require('../src/services/fxRateService');

describe('subscription renewal extends active period', () => {
  it('extends ends_at from current ends_at when active same plan', () => {
    assert.match(subSrc, /activeStillValid/);
    assert.match(subSrc, /baseEnd\.getTime\(\) \+ periodDays/);
    assert.match(subSrc, /FOR UPDATE/);
  });
  it('creates new period when no valid active subscription', () => {
    assert.match(subSrc, /New cycle: expire previous active rows/);
  });
});

describe('demo system fully removed', () => {
  it('no demo confirm/cancel exports or routes in payzenoService', () => {
    assert.equal(typeof payzeno.confirmDemoPayment, 'undefined');
    assert.equal(typeof payzeno.cancelDemoPayment, 'undefined');
    assert.equal(typeof payzeno.isBillingDemoMode, 'undefined');
    assert.ok(!/confirmDemoPayment/.test(pzSrc));
    assert.ok(!/finalizeDemoCheckout/.test(pzSrc));
  });
  it('frontend no longer shows demo panel', () => {
    assert.ok(!/showDemoCheckoutPanel/.test(front));
    assert.ok(!/MODO DE DEMONSTRAÇÃO/.test(front));
  });
});

describe('dark theme billing surfaces', () => {
  it('uses surface-panel and graphite tokens', () => {
    assert.match(css, /--surface-panel/);
    assert.match(css, /--color-graphite/);
    assert.match(css, /--color-acid-lime/);
  });
});

describe('FX minor-unit conversion', () => {
  it('converts USD cents to local minor units with ceil policy', () => {
    // 1999 cents * 63.5 MZN/USD = 1269.365 → ceil minor = 126937 (if 2 digits? wait)
    // 19.99 * 63.5 = 1269.365 → ceil to 0.01 → 1269.37 → minor 126937
    const conv = fx.convertUsdCentsToLocal(1999, 63.5, { currency: 'MZN' });
    assert.equal(conv.minorDigits, 2);
    assert.equal(conv.minorUnits, 126937);
    assert.ok(Math.abs(conv.majorUnits - 1269.37) < 1e-9);
  });

  it('USD identity conversion preserves cents', () => {
    const conv = fx.convertUsdCentsToLocal(1999, 1, { currency: 'USD' });
    assert.equal(conv.minorUnits, 1999);
    assert.equal(conv.majorUnits, 19.99);
    assert.equal(conv.minorDigits, 2);
  });

  it('never under-charges (ceil)', () => {
    // 19.99 * 1.001 = 20.00999 → ceil to 20.01
    const conv = fx.convertUsdCentsToLocal(1999, 1.001, { currency: 'ZAR' });
    assert.equal(conv.minorUnits, 2001);
  });

  it('rejects invalid inputs', () => {
    assert.throws(() => fx.convertUsdCentsToLocal(-1, 1, { currency: 'USD' }), (e) => e.code === 'FX_INVALID');
    assert.throws(() => fx.convertUsdCentsToLocal(100, 0, { currency: 'USD' }), (e) => e.code === 'FX_INVALID');
  });

  it('rejects unknown currencies (no silent 2-decimal fallback)', () => {
    assert.throws(
      () => fx.convertUsdCentsToLocal(1999, 1.5, { currency: 'XYZ' }),
      (e) => e && e.code === 'CURRENCY_UNSUPPORTED'
    );
  });
});
