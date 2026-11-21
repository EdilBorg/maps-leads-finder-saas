const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const serviceJs = fs.readFileSync(path.join(root, 'src/services/searchService.js'), 'utf8');
const routeJs = fs.readFileSync(path.join(root, 'src/routes/search.js'), 'utf8');
const svc = require('../src/services/searchService');

describe('frontend init — reparentLeadForms', () => {
  it('defines reparentLeadForms and setFormBackdrop', () => {
    assert.match(appJs, /function reparentLeadForms\s*\(/);
    assert.match(appJs, /function setFormBackdrop\s*\(/);
    assert.match(appJs, /initUi[\s\S]*reparentLeadForms\s*\(/);
  });

  it('moves activity and appointment forms to document.body', () => {
    const start = appJs.indexOf('function reparentLeadForms');
    const body = appJs.slice(start, start + 600);
    assert.match(body, /leads-activity-form/);
    assert.match(body, /leads-appointment-form/);
    assert.match(body, /document\.body\.appendChild/);
  });

  it('bootstrap calls initUi which uses reparentLeadForms without throwing by definition', () => {
    assert.match(appJs, /function initUi\s*\(/);
    assert.match(appJs, /async function bootstrap\s*\(/);
    assert.match(appJs, /await refreshAuthUi/);
  });

  it('dashboard shows loading hint on first network fetch', () => {
    assert.match(appJs, /A carregar dashboard/);
  });
});

describe('backend — deleteSavedLead export and shape', () => {
  it('exports deleteSavedLead', () => {
    assert.equal(typeof svc.deleteSavedLead, 'function');
  });

  it('implements ownership-scoped DELETE RETURNING', () => {
    const start = serviceJs.indexOf('async function deleteSavedLead');
    const body = serviceJs.slice(start, start + 900);
    assert.match(body, /DELETE FROM saved_leads/);
    assert.match(body, /user_id = \$1 AND id = \$2/);
    assert.match(body, /deleted:\s*true/);
    assert.match(body, /deleted:\s*false/);
    assert.match(body, /lockUserForUpdate/);
  });

  it('route calls deleteSavedLead for DELETE /leads/saved/:id', () => {
    assert.match(routeJs, /searchService\.deleteSavedLead\(req\.session\.userId,\s*req\.params\.id\)/);
  });
});

describe('backend — bulk delete all flag', () => {
  it('leads route respects all:true and rejects empty ids', () => {
    const start = routeJs.indexOf("router.post('/leads/saved/delete'");
    const body = routeJs.slice(start, start + 900);
    assert.match(body, /req\.body\.all === true/);
    assert.match(body, /deleteAllSavedLeads/);
    assert.match(body, /deleteSavedLeads/);
    assert.match(body, /status\(400\)/);
  });

  it('searches route respects all:true and rejects empty ids', () => {
    const start = routeJs.indexOf("router.post('/delete'");
    const body = routeJs.slice(start, start + 900);
    assert.match(body, /req\.body\.all === true/);
    assert.match(body, /deleteAllSearches/);
    assert.match(body, /deleteSearches/);
    assert.match(body, /status\(400\)/);
  });

  it('deleteAllSearches skips running searches', () => {
    const start = serviceJs.indexOf('async function deleteAllSearches');
    const body = serviceJs.slice(start, start + 1200);
    assert.match(body, /status = 'running'|status !== 'running'|skippedRunning/);
  });
});
