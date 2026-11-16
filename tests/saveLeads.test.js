/**
 * Save leads from search results — route/service/frontend contracts.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

describe('saveLeadsFromResults — service export', () => {
  it('exports saveLeadsFromResults from searchService', () => {
    const svc = require('../src/services/searchService');
    assert.equal(typeof svc.saveLeadsFromResults, 'function');
  });
});

describe('POST /leads/save — route contract', () => {
  it('exposes POST /leads/save with auth, verified email and CSRF', () => {
    const js = fs.readFileSync(path.join(root, 'src/routes/search.js'), 'utf8');
    assert.match(js, /router\.post\('\/leads\/save'/);
    const block = js.slice(js.indexOf("router.post('/leads/save'"));
    const end = block.indexOf('router.', 10);
    const snippet = end > 0 ? block.slice(0, end) : block.slice(0, 800);
    assert.match(snippet, /requireAuth/);
    assert.match(snippet, /requireVerifiedEmail/);
    assert.match(snippet, /requireCsrf/);
    assert.match(snippet, /resultIds/);
    assert.match(snippet, /saveLeadsFromResults/);
    assert.match(snippet, /savedCount/);
    assert.match(snippet, /alreadySavedCount/);
  });

  it('rejects empty resultIds with 400', () => {
    const js = fs.readFileSync(path.join(root, 'src/routes/search.js'), 'utf8');
    const start = js.indexOf("router.post('/leads/save'");
    const snippet = js.slice(start, start + 600);
    assert.match(snippet, /ids\.length/);
    assert.match(snippet, /status\(400\)/);
  });
});

describe('saveLeadsFromResults — ownership and dedup in source', () => {
  it('filters results by user_id and uses identity_key deduplication', () => {
    const js = fs.readFileSync(path.join(root, 'src/services/searchService.js'), 'utf8');
    const start = js.indexOf('async function saveLeadsFromResults');
    assert.ok(start >= 0);
    const snippet = js.slice(start, start + 3500);
    assert.match(snippet, /FROM search_results WHERE id=\$1 AND user_id=\$2/);
    assert.match(snippet, /identity_key/);
    assert.match(snippet, /alreadySaved/);
    assert.match(snippet, /BEGIN/);
    assert.match(snippet, /ROLLBACK/);
    assert.match(snippet, /lockUserForUpdate/);
  });
});

describe('frontend — save selected leads', () => {
  it('defines saveSelectedLeads and binds #btn-save-leads', () => {
    const js = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    assert.match(js, /async function saveSelectedLeads\s*\(/);
    assert.match(js, /\/api\/searches\/leads\/save/);
    assert.match(js, /resultIds/);
    assert.match(js, /X-CSRF-Token/);
    assert.match(js, /btn-save-leads/);
    assert.match(js, /saveSelectedLeads\(\)/);
    assert.match(js, /\.result-check:checked/);
  });

  it('handles savedCount and alreadySavedCount in UI feedback', () => {
    const js = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
    const start = js.indexOf('async function saveSelectedLeads');
    const snippet = js.slice(start, start + 2500);
    assert.match(snippet, /savedCount/);
    assert.match(snippet, /alreadySavedCount/);
    assert.match(snippet, /status === 400/);
    assert.match(snippet, /status === 401/);
    assert.match(snippet, /status === 403/);
  });

  it('results markup includes #btn-save-leads and checkboxes class', () => {
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    assert.match(html, /id="btn-save-leads"/);
  });
});
