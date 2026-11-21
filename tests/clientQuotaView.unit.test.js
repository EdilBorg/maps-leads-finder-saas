const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('client quota view — unified plan usage', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/quotaService.js'), 'utf8');

  it('aggregates total_after_filters for completed/partial searches', () => {
    assert.match(src, /SUM\(total_after_filters\)/);
    assert.match(src, /status IN \('completed', 'partial'\)/);
  });

  it('exposes unified currentPlan and usage.deliveredResults', () => {
    assert.match(src, /currentPlan/);
    assert.match(src, /deliveredResults/);
    assert.match(src, /planLimit/);
    assert.match(src, /duplicatesRemoved/);
  });

  it('uses trial limit of 200 when no paid subscription', () => {
    assert.match(src, /planLimit = TRIAL_MAX_LEADS/);
    assert.match(src, /TRIAL_MAX_LEADS = 200/);
  });
});

describe('settings and plans UI', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

  it('keeps email recovery and removes direct change-password form', () => {
    assert.match(app, /\/api\/auth\/forgot-password/);
    assert.match(app, /\/api\/auth\/resend-verification/);
    assert.doesNotMatch(app, /\/api\/auth\/change-password/);
    assert.doesNotMatch(html, /form-change-password/);
    assert.match(html, /btn-show-reset-password/);
    assert.match(html, /reset-password-panel/);
  });

  it('uses a single plans interface for trial and paid', () => {
    assert.match(html, /plans-current-panel/);
    assert.match(html, /plans-usage-panel/);
    assert.doesNotMatch(html, /plans-trial-panel/);
    const start = app.indexOf('async function loadPlansQuotaView');
    const end = app.indexOf('\n  function init()', start + 10);
    const body = app.slice(start, end > 0 ? end : start + 8000);
    assert.doesNotMatch(body, /Apify|Bright Data|TomTom|providers\.apify/);
    assert.match(body, /fmtUsd/);
    assert.match(body, /Plano actual/);
  });

  it('formats USD prices with dollar sign', () => {
    assert.match(app, /'\$' \+ n\.toFixed\(2\)/);
  });
});
