const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pzSrc = fs.readFileSync(path.join(root, 'src/services/payzenoService.js'), 'utf8');
const billingSrc = fs.readFileSync(path.join(root, 'src/routes/billing.js'), 'utf8');
const front = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const payzeno = require('../src/services/payzenoService');

describe('billing demo mode wiring', () => {
  it('is controlled by BILLING_DEMO_MODE env only', () => {
    assert.equal(typeof payzeno.isBillingDemoMode, 'function');
    const prev = process.env.BILLING_DEMO_MODE;
    process.env.BILLING_DEMO_MODE = 'true';
    assert.equal(payzeno.isBillingDemoMode(), true);
    process.env.BILLING_DEMO_MODE = 'false';
    assert.equal(payzeno.isBillingDemoMode(), false);
    delete process.env.BILLING_DEMO_MODE;
    assert.equal(payzeno.isBillingDemoMode(), false);
    if (prev !== undefined) process.env.BILLING_DEMO_MODE = prev;
    else delete process.env.BILLING_DEMO_MODE;
  });

  it('createCheckoutSession branches to finalizeDemoCheckout when demo', () => {
    assert.match(pzSrc, /if \(demo\) \{\s*return finalizeDemoCheckout/);
    assert.match(pzSrc, /confirmDemoPayment/);
    assert.match(pzSrc, /cancelDemoPayment/);
    assert.match(pzSrc, /source: 'demo'/);
  });

  it('demo endpoints exist and real webhook unchanged fail-closed', () => {
    assert.match(billingSrc, /\/demo\/confirm/);
    assert.match(billingSrc, /\/demo\/cancel/);
    assert.match(pzSrc, /SIGNATURE_CONTRACT_UNCONFIRMED/);
  });

  it('demo confirm refuses when mode off', async () => {
    process.env.BILLING_DEMO_MODE = 'false';
    await assert.rejects(
      () => payzeno.confirmDemoPayment({ userId: 'u1', paymentId: 'p1' }),
      (err) => err && err.code === 'DEMO_DISABLED'
    );
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
    assert.match(front, /billing-card-pro/);
    assert.match(front, /Renovar Pro|Assinar Pro|Reactivar Pro/);
    assert.match(front, /showDemoCheckoutPanel/);
    assert.match(front, /MODO DE DEMONSTRAÇÃO/);
  });
});

describe('payzeno real path preserved', () => {
  it('still has hosted checkout and ownership keys', () => {
    assert.match(pzSrc, /\/v1\/checkout\/sessions/);
    assert.match(pzSrc, /payzeno:u:\$\{userId\}/);
    assert.match(pzSrc, /AND user_id = \$2/);
  });
});
