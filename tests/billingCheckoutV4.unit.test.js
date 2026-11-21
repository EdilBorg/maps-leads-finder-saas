
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

describe('logos larger, names removed, cards preserved (V6)', () => {
  it('logo max size increased beyond V5 (96×50) with fixed card height', () => {
    assert.match(css, /max-width:\s*96px/);
    assert.match(css, /max-height:\s*50px/);
    assert.match(css, /height:\s*72px/);
    assert.match(css, /min-height:\s*72px/);
    assert.match(css, /checkout-methods-grid/);
    assert.match(css, /object-fit:\s*contain/);
    assert.match(css, /grid-template-columns:\s*repeat\(3/);
  });
  it('method names are not rendered visually; aria-label provides accessible name', () => {
    assert.match(front, /aria-label="/);
    assert.ok(!/<span class="checkout-method-name">/.test(front) || /display:\s*none/.test(css));
    assert.match(front, /mpesa:\s*\{\s*label:\s*'M-Pesa'/);
    assert.match(front, /multicaixa:\s*\{\s*label:\s*'Multicaixa'/);
  });
  it('HTML img dimensions increased for larger logos', () => {
    assert.match(front, /width="96"\s+height="50"/);
  });
});

describe('major-unit ceil for non-card methods (source)', () => {
  it('FX convert still ceils to minor units', () => {
    // 19.99 * 63.792 = 1275.20208 → ceil to next cent = 1275.21 (127521 minor)
    const r = fx.convertUsdCentsToLocal(1999, 63.792, { currency: 'MZN' });
    assert.equal(r.minorUnits, 127521);
    assert.ok(Math.abs(r.majorUnits - 1275.21) < 1e-9);
  });

  it('payzenoService source applies Math.ceil on major for non-card', () => {
    assert.match(pzSrc, /m !== 'card'/);
    assert.match(pzSrc, /Math\.ceil\(chargeMajor\)/);
  });

  it('card path does not apply major-unit ceil', () => {
    assert.match(pzSrc, /currency !== 'USD'/);
    assert.match(pzSrc, /if \(m !== 'card'\)/);
  });
});

describe('buildCheckoutQuote real function — major-unit ceil', () => {
  const planService = require('../src/services/planService');
  const originalGetPlan = planService.getPlanById;
  const originalGetUsd = fx.getUsdRate;

  const fakePlan = {
    id: 'plan-pro-test',
    name: 'Pro',
    isActive: true,
    priceCents: 1999,
    currency: 'USD',
  };

  // Deterministic rates that produce known fractional majors
  // 19.99 * rate → major after minor-ceil, then major-ceil for non-card
  const rates = {
    MZN: 62.5313,   // 19.99 * 62.5313 ≈ 1249.990 ≈ 1249.99 after minor ceil → ceil major → 1250
    AOA: 625.3127,  // → ~12500-ish; we'll assert integer + >= raw
    ZAR: 17.5088,   // 19.99 * 17.5088 ≈ 350.001 → 350.01 minor → ceil → 351
  };

  async function withMocks(rateMap, fn) {
    planService.getPlanById = async () => fakePlan;
    fx.getUsdRate = async (quote) => {
      const q = String(quote).toUpperCase();
      const rate = rateMap[q];
      if (rate == null) throw Object.assign(new Error('no rate'), { code: 'FX_MISSING' });
      return {
        rate,
        rateDate: '2026-11-21',
        source: 'test-mock',
        fetchedAt: new Date().toISOString(),
        base: 'USD',
        quote: q,
      };
    };
    try {
      return await fn();
    } finally {
      planService.getPlanById = originalGetPlan;
      fx.getUsdRate = originalGetUsd;
    }
  }

  it('M-Pesa / e-Mola / Multicaixa / PayFast produce integer major', async () => {
    await withMocks(rates, async () => {
      for (const method of ['mpesa', 'emola', 'multicaixa', 'payfast']) {
        const q = await payzeno.buildCheckoutQuote({ planId: fakePlan.id, method });
        assert.equal(q.method, method);
        assert.ok(Number.isInteger(q.amountMajor), `${method} amountMajor must be integer, got ${q.amountMajor}`);
        assert.equal(q.amountMinor, q.amountMajor * (10 ** (q.fxSnapshot.minorDigits || 2)));
        // Never under-charge relative to raw conversion
        const conv = fx.convertUsdCentsToLocal(1999, rates[q.currency], { currency: q.currency });
        assert.ok(q.amountMajor >= Math.ceil(conv.majorUnits - 1e-9) || q.amountMajor === Math.ceil(conv.majorUnits));
      }
    });
  });

  it('card preserves exact USD 19.99 (no major ceil)', async () => {
    await withMocks(rates, async () => {
      const q = await payzeno.buildCheckoutQuote({ planId: fakePlan.id, method: 'card' });
      assert.equal(q.method, 'card');
      assert.equal(q.currency, 'USD');
      assert.equal(q.amountMajor, 19.99);
      assert.equal(q.amountMinor, 1999);
    });
  });

  it('required fractional cases via controlled rates', async () => {
    // Rates chosen so convertUsdCentsToLocal produces the intermediate majors
    // listed in the product rule, then major-ceil is applied by buildCheckoutQuote.
    const cases = [
      // post-minor major → expected after major-unit ceil
      { rate: 62.5312656328164, postMinor: 1250.00, expectMajor: 1250 },
      { rate: 62.5313,          postMinor: 1250.01, expectMajor: 1251 },
      { rate: 62.5358,          postMinor: 1250.10, expectMajor: 1251 },
      { rate: 62.5558,          postMinor: 1250.50, expectMajor: 1251 },
      { rate: 62.5803,          postMinor: 1250.99, expectMajor: 1251 },
      { rate: 62.58129,         postMinor: 1251.00, expectMajor: 1251 },
    ];
    for (const c of cases) {
      // Sanity-check the intermediate conversion matches the intended post-minor
      const conv = fx.convertUsdCentsToLocal(1999, c.rate, { currency: 'MZN' });
      assert.ok(
        Math.abs(conv.majorUnits - c.postMinor) < 0.005,
        `rate ${c.rate} produced ${conv.majorUnits}, expected ~${c.postMinor}`
      );
      // Exercise MZN methods with the calibrated rates (AOA/ZAR would need separate scaling)
      await withMocks({ MZN: c.rate, AOA: 900, ZAR: 17.5 }, async () => {
        for (const method of ['mpesa', 'emola']) {
          const q = await payzeno.buildCheckoutQuote({ planId: fakePlan.id, method });
          assert.equal(
            q.amountMajor,
            c.expectMajor,
            `rate=${c.rate} method=${method} got ${q.amountMajor}`
          );
          assert.equal(q.amountMinor, c.expectMajor * 100);
        }
      });
    }
  });

  it('idempotent quote: same inputs → same amountMajor/Minor', async () => {
    await withMocks(rates, async () => {
      const a = await payzeno.buildCheckoutQuote({ planId: fakePlan.id, method: 'mpesa' });
      const b = await payzeno.buildCheckoutQuote({ planId: fakePlan.id, method: 'mpesa' });
      assert.equal(a.amountMajor, b.amountMajor);
      assert.equal(a.amountMinor, b.amountMinor);
      assert.equal(a.currency, b.currency);
    });
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
