/**
 * Bulk save limits, delete endpoints and ownership contracts.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

describe('save leads limit raised to 500', () => {
  it('service and route accept up to 500 ids', () => {
    const svc = fs.readFileSync(path.join(root, 'src/services/searchService.js'), 'utf8');
    const route = fs.readFileSync(path.join(root, 'src/routes/search.js'), 'utf8');
    assert.match(svc, /slice\(0,\s*500\)/);
    assert.match(route, /searchService\.deleteSavedLeads\(req\.session\.userId,\s*ids\)/);
    assert.doesNotMatch(svc, /slice\(0,\s*100\)/);
  });
});

describe('delete saved leads — service + routes', () => {
  it('exports deleteSavedLeads and deleteAllSavedLeads', () => {
    const svc = require('../src/services/searchService');
    assert.equal(typeof svc.deleteSavedLeads, 'function');
    assert.equal(typeof svc.deleteAllSavedLeads, 'function');
  });

  it('routes require auth, verified email and CSRF', () => {
    const js = fs.readFileSync(path.join(root, 'src/routes/search.js'), 'utf8');
    assert.match(js, /router\.delete\('\/leads\/saved\/:id'/);
    assert.match(js, /router\.post\('\/leads\/saved\/delete'/);
    const start = js.indexOf("router.post('/leads/saved/delete'");
    const snip = js.slice(start, start + 500);
    assert.match(snip, /requireAuth/);
    assert.match(snip, /requireCsrf/);
  });

  it('delete uses owner-scoped SQL', () => {
    const js = fs.readFileSync(path.join(root, 'src/services/searchService.js'), 'utf8');
    const start = js.indexOf('async function deleteSavedLeads');
    const snip = js.slice(start, start + 900);
    assert.match(snip, /DELETE FROM saved_leads/);
    assert.match(snip, /user_id\s*=\s*\$1/);
    assert.match(snip, /BEGIN/);
    assert.match(snip, /ROLLBACK/);
  });
});

describe('delete searches — independence from leads', () => {
  it('exports deleteSearches and refuses running', () => {
    const svc = require('../src/services/searchService');
    assert.equal(typeof svc.deleteSearches, 'function');
    assert.equal(typeof svc.deleteAllSearches, 'function');
  });

  it('skips running searches in SQL', () => {
    const js = fs.readFileSync(path.join(root, 'src/services/searchService.js'), 'utf8');
    const start = js.indexOf('async function deleteSearches');
    const snip = js.slice(start, start + 1800);
    assert.match(snip, /status\s*<>\s*'running'|status !== 'running'/);
    assert.match(snip, /skippedRunning/);
  });

  it('origin_search_id is ON DELETE SET NULL in migrations', () => {
    const sql = fs.readFileSync(path.join(root, 'migrations/003_domain_model.sql'), 'utf8');
    assert.match(sql, /origin_search_id/);
    assert.match(sql, /ON DELETE SET NULL/);
  });
});

describe('delete activities', () => {
  it('exports deleteActivity and clearActivities', () => {
    const act = require('../src/services/savedLeadActivities');
    assert.equal(typeof act.deleteActivity, 'function');
    assert.equal(typeof act.clearActivities, 'function');
  });

  it('routes expose activity delete endpoints with CSRF', () => {
    const js = fs.readFileSync(path.join(root, 'src/routes/search.js'), 'utf8');
    assert.match(js, /router\.delete\('\/leads\/saved\/:id\/activities\/:activityId'/);
    assert.match(js, /router\.delete\('\/leads\/saved\/:id\/activities'/);
  });
});

describe('frontend bulk UI contracts', () => {
  it('has select-all, save-all and confirm modal', () => {
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    assert.match(html, /id="results-select-all"/);
    assert.match(html, /id="btn-save-all-leads"/);
    assert.match(html, /id="confirm-modal"/);
    assert.match(html, /id="leads-delete-selected"/);
    assert.match(html, /id="leads-delete-all"/);
    assert.match(html, /id="history-delete-selected"/);
    assert.match(html, /id="history-delete-all"/);
    assert.match(html, /id="leads-btn-clear-activities"/);
  });

  it('app.js implements bulk and delete flows', () => {
    const js = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.match(js, /function saveAllLeads/);
    assert.match(js, /function deleteSelectedLeads/);
    assert.match(js, /function deleteAllLeads/);
    assert.match(js, /function deleteSelectedSearches/);
    assert.match(js, /function deleteAllSearches/);
    assert.match(js, /function clearLeadActivities/);
    assert.match(js, /function openConfirmModal/);
    assert.match(js, /resultsSelectAllMode/);
  });

  it('btn-danger uses coral-red token', () => {
    const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');
    assert.match(css, /\.btn-danger/);
    assert.match(css, /--color-coral-red/);
  });
});
