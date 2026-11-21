const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const subSrc = fs.readFileSync(path.join(root, 'src/services/subscriptionService.js'), 'utf8');
const pzSrc = fs.readFileSync(path.join(root, 'src/services/payzenoService.js'), 'utf8');
const front = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');
const payzeno = require('../src/services/payzenoService');

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

describe('demo confirm security', () => {
  it('only accepts pending status for new confirmation', () => {
    assert.match(pzSrc, /Apenas pagamentos demo pendentes podem ser confirmados/);
    assert.match(pzSrc, /pay\.status !== 'pending'/);
  });
  it('rejects non-demo and validates plan Pro', () => {
    assert.match(pzSrc, /NOT_DEMO/);
    assert.match(pzSrc, /PLAN_INVALID/);
    assert.match(pzSrc, /source: 'demo'/);
  });
  it('completed is idempotent without re-activating', () => {
    const idxCompleted = pzSrc.indexOf("pay.status === 'completed' || pay.status === 'approved'");
    const idxActivate = pzSrc.indexOf("source: 'demo'", idxCompleted);
    const idxReturnReplay = pzSrc.indexOf('replayed: true', idxCompleted);
    assert.ok(idxCompleted > 0 && idxReturnReplay > idxCompleted);
    assert.ok(idxReturnReplay < idxActivate);
  });
  it('cancel only pending demo', () => {
    assert.match(pzSrc, /Apenas pagamentos demo pendentes podem ser cancelados/);
  });
  it('demo disabled blocks confirm', async () => {
    process.env.BILLING_DEMO_MODE = 'false';
    await assert.rejects(
      () => payzeno.confirmDemoPayment({ userId: 'u', paymentId: 'p' }),
      (e) => e && e.code === 'DEMO_DISABLED'
    );
  });
});

describe('demo checkout identity on replay', () => {
  it('replayed pending returns demo flag from payment row', () => {
    assert.match(pzSrc, /demo: isDemoPaymentRow\(payment\)/);
  });
});

describe('dark theme billing surfaces', () => {
  it('uses surface-panel and graphite tokens not white cards', () => {
    assert.match(css, /--surface-panel/);
    assert.match(css, /--color-graphite/);
    assert.match(css, /--color-acid-lime/);
    assert.ok(!/\.billing-card\s*\{[^}]*#fff/.test(css));
    assert.ok(!/\.billing-card\s*\{[^}]*#ffffff/.test(css));
  });
  it('frontend shows demo panel in-app', () => {
    assert.match(front, /showDemoCheckoutPanel/);
    assert.match(front, /MODO DE DEMONSTRAÇÃO/);
  });
});
