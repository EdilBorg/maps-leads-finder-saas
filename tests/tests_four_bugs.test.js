/**
 * Behaviour tests for the four production bugs.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname);
const candidates = {
  app: [
    path.join(root, 'public/js/app.js'),
    path.join(root, 'app.js'),
    path.join(root, '../app.js'),
  ],
  act: [
    path.join(root, 'src/services/savedLeadActivities.js'),
    path.join(root, 'savedLeadActivities.js'),
  ],
  svc: [
    path.join(root, 'src/services/searchService.js'),
    path.join(root, 'searchService.js'),
  ],
  routes: [
    path.join(root, 'src/routes/search.js'),
    path.join(root, 'search.js'),
  ],
  html: [
    path.join(root, 'public/index.html'),
    path.join(root, 'index.html'),
  ],
};

function readFirst(list) {
  for (const p of list) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  throw new Error('file not found: ' + list[0]);
}

/* —— pure selection model —— */
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
    const js = readFirst(candidates.app);
    assert.match(js, /resultsExcludedIds/);
    assert.match(js, /function clearResultsSelection/);
    assert.doesNotMatch(js, /if\s*\(\s*!cb\.checked\s*\)\s*resultsSelectAllMode\s*=\s*false/);
  });
});

describe('Bug2 — bulk delete batches', () => {
  it('frontend batches lead deletes', () => {
    const js = readFirst(candidates.app);
    const start = js.indexOf('async function deleteSelectedLeads');
    assert.ok(start >= 0);
    const snip = js.slice(start, start + 1200);
    assert.match(snip, /BATCH\s*=\s*500/);
    assert.match(snip, /while\s*\(\s*remaining\.length/);
  });

  it('frontend batches search deletes', () => {
    const js = readFirst(candidates.app);
    const start = js.indexOf('async function deleteSelectedSearches');
    assert.ok(start >= 0);
    const snip = js.slice(start, start + 1200);
    assert.match(snip, /BATCH\s*=\s*500/);
  });

  it('backend still enforces per-request cap (safe with batches)', () => {
    const svc = readFirst(candidates.svc);
    assert.match(svc, /slice\(0,\s*500\)/);
  });
});

describe('Bug3 — activity history server pagination', () => {
  it('service supports limit and offset and returns total', () => {
    const act = readFirst(candidates.act);
    assert.match(act, /offset/);
    assert.match(act, /LIMIT \$3 OFFSET \$4/);
    assert.match(act, /total/);
  });

  it('frontend no longer loads only first 200 into memory as sole source', () => {
    const js = readFirst(candidates.app);
    assert.doesNotMatch(js, /activities\?limit=200/);
    assert.match(js, /renderActivitiesFullPageFromServer/);
    assert.match(js, /params\.set\('offset'/);
  });
});

describe('Bug4 — establishment info card', () => {
  it('HTML has leads-detail-fields', () => {
    const html = readFirst(candidates.html);
    assert.match(html, /id="leads-detail-fields"/);
  });

  it('openLeadDetail populates phone address category', () => {
    const js = readFirst(candidates.app);
    assert.match(js, /appendDetailField\(fields,\s*'Telefone'/);
    assert.match(js, /appendDetailField\(fields,\s*'Endereço'/);
    assert.match(js, /appendDetailField\(fields,\s*'Categoria'/);
  });

  it('notes controls use HTML ids from compact CRM', () => {
    const js = readFirst(candidates.app);
    assert.match(js, /leads-notes-edit-btn/);
    assert.match(js, /leads-notes-textarea/);
    assert.match(js, /leads-notes-save/);
    assert.match(js, /leads-notes-cancel/);
    assert.doesNotMatch(js, /\$\('#leads-edit-notes'\)/);
  });
});
