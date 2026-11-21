const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const searchJs = fs.readFileSync(path.join(root, 'src/services/searchService.js'), 'utf8');
const leadJs = fs.readFileSync(path.join(root, 'src/services/leadQuotaService.js'), 'utf8');
const recoveryJs = fs.readFileSync(path.join(root, 'src/services/abandonedSearchRecovery.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/leads.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

describe('engine catch: cancelled must release Pro quota before return', () => {
  it('releases lead quota inside cancelled branch of first catch', () => {
    const i = searchJs.indexOf('async function runSearchJob');
    const catchIdx = searchJs.indexOf('} catch (err) {', i);
    const body = searchJs.slice(catchIdx, catchIdx + 1800);
    // cancelled branch must call releaseLeadQuota before return
    const cancelled = body.indexOf("status === 'cancelled'");
    const release = body.indexOf('releaseLeadQuota', cancelled);
    const ret = body.indexOf('return;', release);
    assert.ok(cancelled >= 0, 'cancelled branch present');
    assert.ok(release > cancelled, 'release after cancelled check');
    assert.ok(ret > release, 'return only after release');
  });

  it('releases lead quota on failed path inside same TX', () => {
    const i = searchJs.indexOf('async function runSearchJob');
    const catchIdx = searchJs.indexOf('} catch (err) {', i);
    const body = searchJs.slice(catchIdx, catchIdx + 2200);
    assert.match(body, /status='failed'/);
    assert.match(body, /releaseLeadQuota\(client/);
  });
});

describe('orphan recovery is wired into app lifecycle', () => {
  it('abandonedSearchRecovery calls recoverOrphanedLeadHolds', () => {
    assert.match(recoveryJs, /recoverOrphanedLeadHolds/);
    assert.match(recoveryJs, /lead_quota_orphans/);
  });

  it('server starts abandoned recovery (which runs lead quota recovery)', () => {
    assert.match(serverJs, /startAbandonedSearchRecovery/);
  });

  it('recovery re-checks search status under locks', () => {
    const i = leadJs.indexOf('async function recoverOrphanedLeadHolds');
    const body = leadJs.slice(i, i + 2000);
    assert.match(body, /FOR UPDATE/);
    assert.match(body, /still_active/);
    assert.match(body, /lockUserForUpdate/);
  });
});

describe('paid-only sumDeliveredInPeriod', () => {
  it('filters quotaMode paid', () => {
    const i = leadJs.indexOf('async function sumDeliveredInPeriod');
    assert.match(leadJs.slice(i, i + 700), /'paid'/);
  });
});

describe('CRM forms closed on view change', () => {
  it('showView closes activity and appointment forms', () => {
    const i = appJs.indexOf('function showView');
    const body = appJs.slice(i, i + 900);
    assert.match(body, /showActivityForm\(false\)/);
    assert.match(body, /showAppointmentForm\(false\)/);
  });

  it('CSS forces display none on hidden form modals', () => {
    assert.match(css, /\.leads-crm-form-modal\[hidden\][\s\S]*display:\s*none\s*!important/);
  });
});
