
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const fx = require('../src/services/fxRateService');
const front = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/billing.css'), 'utf8');
const pzSrc = fs.readFileSync(path.join(root, 'src/services/payzenoService.js'), 'utf8');
const billingSrc = fs.readFileSync(path.join(root, 'src/routes/billing.js'), 'utf8');
const payzeno = require('../src/services/payzenoService');

describe('Frankfurter v2 response parsing', () => {
  it('parses real array shape with three currencies', () => {
    const data = [
      { date: '2026-11-20', base: 'USD', quote: 'AOA', rate: 918.77 },
      { date: '2026-11-20', base: 'USD', quote: 'MZN', rate: 63.792 },
      { date: '2026-11-22', base: 'USD', quote: 'ZAR', rate: 17.4055 },
    ];
    const rows = fx.parseFrankfurterResponse(data, ['MZN', 'AOA', 'ZAR']);
    assert.equal(rows.length, 3);
    const byQ = Object.fromEntries(rows.map((r) => [r.quote, r]));
    assert.equal(byQ.MZN.rate, 63.792);
    assert.equal(byQ.AOA.rateDate, '2026-11-20');
    assert.equal(byQ.ZAR.base, 'USD');
  });

  it('handles single-currency response', () => {
    const data = [{ date: '2026-11-20', base: 'USD', quote: 'MZN', rate: 63.5 }];
    const rows = fx.parseFrankfurterResponse(data, ['MZN', 'AOA', 'ZAR']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quote, 'MZN');
  });

  it('rejects empty array', () => {
    assert.equal(fx.parseFrankfurterResponse([], ['MZN']).length, 0);
  });

  it('skips invalid rates', () => {
    const data = [
      { date: '2026-11-20', base: 'USD', quote: 'MZN', rate: -1 },
      { date: '2026-11-20', base: 'USD', quote: 'AOA', rate: null },
      { date: '2026-11-20', base: 'USD', quote: 'ZAR', rate: 17.4 },
    ];
    const rows = fx.parseFrankfurterResponse(data, ['MZN', 'AOA', 'ZAR']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quote, 'ZAR');
  });

  it('still accepts legacy v1 object shape', () => {
    const data = { date: '2026-11-20', rates: { MZN: 63.5, AOA: 900 } };
    const rows = fx.parseFrankfurterResponse(data, ['MZN', 'AOA']);
    assert.equal(rows.length, 2);
  });
});

describe('FX conversion precision', () => {
  it('converts integer USD cents', () => {
    const r = fx.convertUsdCentsToLocal(1999, 63.792, { currency: 'MZN' });
    assert.equal(r.minorDigits, 2);
    assert.ok(Number.isInteger(r.minorUnits));
    assert.ok(r.minorUnits >= 127480); // ceil of 19.99*63.792
  });

  it('rejects fractional usdCents (no silent trunc)', () => {
    assert.throws(
      () => fx.convertUsdCentsToLocal(19.99, 63.5, { currency: 'MZN' }),
      (e) => e && e.code === 'FX_INVALID'
    );
  });

  it('rejects unknown currency', () => {
    assert.throws(
      () => fx.convertUsdCentsToLocal(100, 1, { currency: 'XYZ' }),
      (e) => e && e.code === 'CURRENCY_UNSUPPORTED'
    );
  });
});

describe('phone UX by method', () => {
  it('defines prefixes for mobile money and free entry for card', () => {
    assert.match(front, /mpesa:\s*\{\s*prefix:\s*'\+258'/);
    assert.match(front, /emola:\s*\{\s*prefix:\s*'\+258'/);
    assert.match(front, /multicaixa:\s*\{\s*prefix:\s*'\+244'/);
    assert.match(front, /payfast:\s*\{\s*prefix:\s*'\+27'/);
    assert.match(front, /card:\s*\{\s*prefix:\s*null/);
    assert.match(front, /normalizePhoneForMethod/);
    assert.match(front, /applyPhoneUiForMethod/);
  });
});

describe('idempotency quote consistency', () => {
  it('backend refuses replay when amount/currency differ', () => {
    assert.match(pzSrc, /quoteMatches/);
    assert.match(pzSrc, /storedMinor === Number\(quote\.amountMinor\)/);
    assert.match(pzSrc, /replayQuote/);
  });
  it('frontend scopes attempt token by amount and currency', () => {
    assert.match(front, /billingAttempt:/);
    assert.match(front, /amountMinor/);
    assert.match(front, /getOrCreateAttemptToken\(pro\.id, selectedMethod, amountMinor, currency\)/);
  });
});

describe('logos slightly larger, cards preserved', () => {
  it('logo max size increased without changing grid structure', () => {
    assert.match(css, /max-width:\s*64px/);
    assert.match(css, /max-height:\s*34px/);
    assert.match(css, /checkout-methods-grid/);
    assert.match(css, /object-fit:\s*contain/);
  });
});

describe('return URLs and webhook safety', () => {
  it('server-owned return URLs', () => {
    assert.ok(!/req\.body && req\.body\.successUrl/.test(billingSrc));
    assert.match(billingSrc, /APP_URL/);
  });
  it('webhook fail-closed', () => {
    const v = payzeno.verifyWebhookSignature({
      rawBody: '{}', signature: 'x', timestamp: '1', secret: 's',
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'SIGNATURE_CONTRACT_UNCONFIRMED');
  });
});
