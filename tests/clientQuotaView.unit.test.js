const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('client quota view — delivered results', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/quotaService.js'), 'utf8');

  it('aggregates total_after_filters for completed/partial paid searches', () => {
    assert.match(src, /SUM\(total_after_filters\)/);
    assert.match(src, /status IN \('completed', 'partial'\)/);
    assert.match(src, /quotaMode.*paid/);
  });

  it('exposes usage.deliveredResults without relying on provider quotas for clients', () => {
    assert.match(src, /deliveredResults/);
    assert.match(src, /planLimit/);
  });
});

describe('settings UI wiring', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  it('wires change-password and resend-verification to real endpoints', () => {
    assert.match(app, /\/api\/auth\/change-password/);
    assert.match(app, /\/api\/auth\/resend-verification/);
    assert.match(html, /form-change-password/);
    assert.match(html, /btn-resend-verification/);
  });

  it('plans page does not present provider quota codes to the client', () => {
    const start = app.indexOf('async function loadPlansQuotaView');
    const end = app.indexOf('\n  function ', start + 10);
    const body = app.slice(start, end > 0 ? end : start + 5000);
    assert.doesNotMatch(body, /Apify|Bright Data|TomTom|brightdata|providers\.apify/);
    assert.match(body, /deliveredResults|Resultados entregues/);
  });
});
