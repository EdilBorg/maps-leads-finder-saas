const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('frontend load performance patterns', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

  it('bootstraps after auth before dashboard', () => {
    assert.match(app, /async function bootstrap\s*\(/);
    assert.match(app, /await refreshAuthUi\s*\(/);
    assert.match(app, /appBootstrapped/);
    const boot = app.slice(app.indexOf('async function bootstrap'), app.indexOf('async function bootstrap') + 500);
    assert.ok(boot.indexOf('await refreshAuthUi') < boot.indexOf("showView('dashboard')"));
  });

  it('caches dashboard with TTL and in-flight dedupe', () => {
    assert.match(app, /DASHBOARD_TTL_MS\s*=\s*10000/);
    assert.match(app, /dashboardInFlight/);
    assert.match(app, /invalidateDashboardCache/);
    assert.match(app, /loadDashboard\(\{\s*force:\s*true\s*\}\)/);
  });

  it('loads plans quota/plans/payments in parallel', () => {
    const i = app.indexOf('async function loadPlansQuotaViewBody');
    const body = app.slice(i, i + 4000);
    assert.match(body, /Promise\.all\s*\(/);
    assert.match(body, /\/api\/billing\/quota/);
    assert.match(body, /\/api\/billing\/plans/);
    assert.match(body, /\/api\/billing\/payments/);
  });

  it('dedupes concurrent plans and settings loads', () => {
    assert.match(app, /plansInFlight/);
    assert.match(app, /settingsInFlight/);
  });
});
