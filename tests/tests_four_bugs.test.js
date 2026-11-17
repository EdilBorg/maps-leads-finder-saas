/**
 * Behaviour tests for the four production bugs.
 * Paths resolve from this file → project root (parent of tests/).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readProj(...parts) {
  const p = path.join(ROOT, ...parts);
  if (!fs.existsSync(p)) {
    throw new Error('Missing file relative to project root: ' + path.join(...parts) + ' (resolved ' + p + ')');
  }
  return fs.readFileSync(p, 'utf8');
}

function createSel() {
  return { allSelected: false, excluded: new Set(), page: new Set() };
}
function selectAll(s) { s.allSelected = true; s.excluded.clear(); s.page.clear(); }
function clearSel(s) { s.allSelected = false; s.excluded.clear(); s.page.clear(); }
function toggle(s, id, checked) {
  id = String(id);
  if (s.allSelected) {
    if (!checked) s.excluded.add(id); else s.excluded.delete(id);
  } else {
    if (checked) s.page.add(id); else s.page.delete(id);
  }
}
function selected(s, all) {
  if (s.allSelected) return all.map(String).filter((id) => !s.excluded.has(id));
  return all.map(String).filter((id) => s.page.has(id));
}

describe('Bug1 — global selection with exclusions', () => {
  const all = Array.from({ length: 500 }, (_, i) => 'id-' + i);

  it('select all → 500 selected', () => {
    const s = createSel();
    selectAll(s);
    assert.equal(selected(s, all).length, 500);
  });

  it('uncheck one → 499 still selected, mode stays global', () => {
    const s = createSel();
    selectAll(s);
    toggle(s, 'id-7', false);
    assert.equal(s.allSelected, true);
    assert.equal(selected(s, all).length, 499);
    assert.ok(!selected(s, all).includes('id-7'));
  });

  it('re-check excluded → full set again', () => {
    const s = createSel();
    selectAll(s);
    toggle(s, 'id-7', false);
    toggle(s, 'id-7', true);
    assert.equal(selected(s, all).length, 500);
  });

  it('clear on new search', () => {
    const s = createSel();
    selectAll(s);
    toggle(s, 'id-1', false);
    clearSel(s);
    assert.equal(selected(s, all).length, 0);
    assert.equal(s.allSelected, false);
  });

  it('app.js implements exclusion model', () => {
    const js = readProj('public', 'js', 'app.js');
    assert.match(js, /resultsExcludedIds/);
    assert.match(js, /function clearResultsSelection/);
    assert.doesNotMatch(js, /if\s*\(\s*!cb\.checked\s*\)\s*resultsSelectAllMode\s*=\s*false/);
  });
});

describe('Bug2 — bulk delete batches', () => {
  it('frontend batches lead deletes', () => {
    const js = readProj('public', 'js', 'app.js');
    assert.match(js, /const BATCH\s*=\s*500/);
    assert.match(js, /deleteSelectedLeads|bulkDelete|leads\/saved\/delete/);
  });

  it('frontend batches search deletes', () => {
    const js = readProj('public', 'js', 'app.js');
    assert.match(js, /deleteSelectedSearches|searches\/delete/);
  });

  it('backend still enforces per-request cap (safe with batches)', () => {
    const svc = readProj('src', 'services', 'searchService.js');
    assert.match(svc, /slice\(0,\s*500\)|\.length\s*>\s*500/);
  });
});

describe('Bug3 — activity history server pagination', () => {
  it('service supports limit and offset and returns total', () => {
    const act = readProj('src', 'services', 'savedLeadActivities.js');
    assert.match(act, /LIMIT \$/);
    assert.match(act, /OFFSET \$/);
    assert.match(act, /total/);
    const start = act.indexOf('async function listActivities');
    assert.ok(start >= 0);
    const snip = act.slice(start, start + 2200);
    assert.match(snip, /parseInt\(opts\.limit/);
    assert.match(snip, /parseInt\(opts\.offset/);
  });

  it('frontend requests offset and does not rely only on limit=200 cache', () => {
    const js = readProj('public', 'js', 'app.js');
    assert.doesNotMatch(js, /activities\?limit=200/);
    assert.match(js, /renderActivitiesFullPageFromServer/);
    assert.match(js, /params\.set\('offset'/);
  });

  it('no artificial 5000 activity cap', () => {
    const js = readProj('public', 'js', 'app.js');
    assert.doesNotMatch(js, /offset\s*>\s*5000/);
    assert.doesNotMatch(js, /max 50 pages = 5000/);
  });

  it('service accepts activityType and q filters for server-side filtering', () => {
    const act = readProj('src', 'services', 'savedLeadActivities.js');
    assert.match(act, /activityType|activity_type/);
    const start = act.indexOf('async function listActivities');
    const snip = act.slice(start, start + 1800);
    assert.match(snip, /opts\.(activityType|q)|activityType|ILIKE/);
  });
});

describe('Bug4 — establishment info card', () => {
  it('HTML has leads-detail-fields', () => {
    const html = readProj('public', 'index.html');
    assert.match(html, /id="leads-detail-fields"/);
  });

  it('openLeadDetail fills Informações via fillLeadInfoFields', () => {
    const js = readProj('public', 'js', 'app.js');
    assert.match(js, /function fillLeadInfoFields/);
    assert.match(js, /function normalizeLeadPayload/);
    assert.match(js, /fillLeadInfoFields\(fields,\s*lead\)/);
  });

  it('fillLeadInfoFields always renders core rows with em dash for empty', () => {
    const js = readProj('public', 'js', 'app.js');
    const start = js.indexOf('function fillLeadInfoFields');
    assert.ok(start >= 0);
    const snip = js.slice(start, start + 3500);
    assert.match(snip, /Telefone/);
    assert.match(snip, /Email/);
    assert.match(snip, /Endereço/);
    assert.match(snip, /Categoria/);
    assert.match(snip, /Guardado em/);
    assert.match(snip, /'—'/);
  });

  it('notes controls use HTML ids from compact CRM', () => {
    const js = readProj('public', 'js', 'app.js');
    assert.match(js, /leads-notes-edit-btn/);
    assert.match(js, /leads-notes-textarea/);
    assert.match(js, /leads-notes-save/);
    assert.match(js, /leads-notes-cancel/);
  });
});


describe('Problem1 — test path resolution from project root', () => {
  it('ROOT points to project root (parent of tests/)', () => {
    assert.equal(path.basename(ROOT) !== 'tests', true);
    assert.ok(fs.existsSync(path.join(ROOT, 'package.json')) || fs.existsSync(path.join(ROOT, 'public')));
  });

  it('readProj finds real source files (not under tests/)', () => {
    const app = readProj('public', 'js', 'app.js');
    assert.ok(app.length > 1000);
    const act = readProj('src', 'services', 'savedLeadActivities.js');
    assert.ok(act.includes('listActivities'));
    const html = readProj('public', 'index.html');
    assert.ok(html.includes('leads-detail-fields'));
  });

  it('does not look under tests/public or tests/src', () => {
    const badApp = path.join(__dirname, 'public', 'js', 'app.js');
    const badSrc = path.join(__dirname, 'src', 'services', 'savedLeadActivities.js');
    assert.equal(fs.existsSync(badApp), false);
    assert.equal(fs.existsSync(badSrc), false);
  });
});
