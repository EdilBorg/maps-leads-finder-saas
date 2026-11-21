const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const searchJs = fs.readFileSync(path.join(root, 'src/services/searchService.js'), 'utf8');
const leadJs = fs.readFileSync(path.join(root, 'src/services/leadQuotaService.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/leads.css'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');

describe('paid-only commercial delivery accounting', () => {
  it('sumDeliveredInPeriod filters quotaMode paid', () => {
    const i = leadJs.indexOf('async function sumDeliveredInPeriod');
    const body = leadJs.slice(i, i + 900);
    assert.match(body, /filters->>'quotaMode'/);
    assert.match(body, /'paid'/);
  });
});

describe('lead quota release on terminal paths', () => {
  it('exports safe release and orphan recovery', () => {
    assert.match(leadJs, /releaseLeadQuotaSafe/);
    assert.match(leadJs, /recoverOrphanedLeadHolds/);
  });

  it('releases on engine error, persist failure, cancel, and cancelled status', () => {
    assert.match(searchJs, /reason: 'engine_error'/);
    assert.match(searchJs, /reason: 'persist_failure'/);
    assert.match(searchJs, /reason: 'cancel_search'/);
    assert.match(searchJs, /reason: 'start_search_abort'/);
    // cancelled when engine ends — release inside same TX
    const i = searchJs.indexOf("status === 'cancelled'");
    assert.ok(i > 0);
    assert.match(searchJs, /releaseLeadQuota\(client/);
  });

  it('logs still-held when safe release fails', () => {
    assert.match(searchJs, /lead-quota-still-held/);
  });
});

describe('CRM form visibility', () => {
  it('forces display:none for hidden modal forms', () => {
    assert.match(css, /\.leads-crm-form-modal\[hidden\]/);
    assert.match(css, /display:\s*none\s*!important/);
  });

  it('reparent keeps forms closed', () => {
    const i = appJs.indexOf('function reparentLeadForms');
    const body = appJs.slice(i, i + 600);
    assert.match(body, /el\.hidden = true/);
    assert.match(body, /setAttribute\('hidden'/);
  });
});
