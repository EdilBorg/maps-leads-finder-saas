/**
 * Behaviour tests for global result selection (inclusion / exclusion model).
 * Mirrors the algorithm used in public/js/app.js without a browser.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function createSelectionState() {
  return {
    allSelected: false,
    excludedIds: new Set(),
    pageChecked: new Set(),
  };
}

function selectAll(state) {
  state.allSelected = true;
  state.excludedIds.clear();
  state.pageChecked.clear();
}

function clearSelection(state) {
  state.allSelected = false;
  state.excludedIds.clear();
  state.pageChecked.clear();
}

function toggleOne(state, id, checked, allResultIds) {
  id = String(id);
  if (state.allSelected) {
    if (!checked) state.excludedIds.add(id);
    else state.excludedIds.delete(id);
  } else {
    if (checked) state.pageChecked.add(id);
    else state.pageChecked.delete(id);
  }
}

function getSelectedIds(state, allResultIds) {
  const ids = allResultIds.map(String);
  if (state.allSelected) {
    return ids.filter((id) => !state.excludedIds.has(id));
  }
  return ids.filter((id) => state.pageChecked.has(id));
}

function selectedCount(state, allResultIds) {
  return getSelectedIds(state, allResultIds).length;
}

describe('global results selection — behaviour', () => {
  const all = ['a', 'b', 'c', 'd', 'e'];

  it('select all selects every result id', () => {
    const s = createSelectionState();
    selectAll(s);
    assert.deepEqual(getSelectedIds(s, all), all);
    assert.equal(selectedCount(s, all), 5);
  });

  it('unchecking one keeps the rest selected', () => {
    const s = createSelectionState();
    selectAll(s);
    toggleOne(s, 'c', false, all);
    assert.deepEqual(getSelectedIds(s, all), ['a', 'b', 'd', 'e']);
    assert.equal(s.allSelected, true);
    assert.ok(s.excludedIds.has('c'));
  });

  it('unchecking several excludes only those ids', () => {
    const s = createSelectionState();
    selectAll(s);
    toggleOne(s, 'a', false, all);
    toggleOne(s, 'e', false, all);
    assert.deepEqual(getSelectedIds(s, all), ['b', 'c', 'd']);
  });

  it('re-checking an excluded id restores full selection', () => {
    const s = createSelectionState();
    selectAll(s);
    toggleOne(s, 'b', false, all);
    toggleOne(s, 'b', true, all);
    assert.deepEqual(getSelectedIds(s, all), all);
    assert.equal(s.excludedIds.size, 0);
  });

  it('save payload is all minus excluded', () => {
    const s = createSelectionState();
    selectAll(s);
    toggleOne(s, 'a', false, all);
    toggleOne(s, 'd', false, all);
    const payload = getSelectedIds(s, all);
    assert.deepEqual(payload, ['b', 'c', 'e']);
  });

  it('clear selection resets global mode and exclusions', () => {
    const s = createSelectionState();
    selectAll(s);
    toggleOne(s, 'a', false, all);
    clearSelection(s);
    assert.equal(s.allSelected, false);
    assert.equal(s.excludedIds.size, 0);
    assert.deepEqual(getSelectedIds(s, all), []);
  });

  it('new search does not inherit previous selection', () => {
    const s = createSelectionState();
    selectAll(s);
    toggleOne(s, 'c', false, all);
    clearSelection(s);
    const next = ['x', 'y', 'z'];
    assert.deepEqual(getSelectedIds(s, next), []);
  });

  it('individual checks do not enable global mode', () => {
    const s = createSelectionState();
    toggleOne(s, 'a', true, all);
    toggleOne(s, 'b', true, all);
    assert.equal(s.allSelected, false);
    assert.deepEqual(getSelectedIds(s, all).sort(), ['a', 'b']);
  });

  it('pagination-safe: non-visible ids remain selected under global mode', () => {
    const s = createSelectionState();
    selectAll(s);
    toggleOne(s, 'b', false, all);
    assert.deepEqual(getSelectedIds(s, all), ['a', 'c', 'd', 'e']);
  });

  it('does not emit duplicate ids for unique input', () => {
    const s = createSelectionState();
    selectAll(s);
    const uniqueInput = ['a', 'b', 'c'];
    const out = getSelectedIds(s, uniqueInput);
    assert.equal(new Set(out).size, out.length);
  });
});

describe('app.js source contracts for selection fix', () => {
  const root = path.join(__dirname, '..');
  const candidates = [
    path.join(root, 'public/js/app.js'),
    path.join(__dirname, 'app.js'),
    path.join(__dirname, '../app.js'),
    path.join(__dirname, '../public/js/app.js'),
  ];
  const appPath = candidates.find((c) => fs.existsSync(c));

  it('uses exclusion set instead of clearing global mode on uncheck', () => {
    assert.ok(appPath, 'app.js not found');
    const js = fs.readFileSync(appPath, 'utf8');
    assert.match(js, /resultsExcludedIds/);
    assert.match(js, /function clearResultsSelection/);
    assert.doesNotMatch(
      js,
      /if\s*\(\s*!cb\.checked\s*\)\s*resultsSelectAllMode\s*=\s*false/
    );
  });

  it('getSelectedResultIds respects exclusions in global mode', () => {
    assert.ok(appPath, 'app.js not found');
    const js = fs.readFileSync(appPath, 'utf8');
    const start = js.indexOf('function getSelectedResultIds');
    assert.ok(start >= 0);
    const snip = js.slice(start, start + 700);
    assert.match(snip, /resultsExcludedIds/);
    assert.match(snip, /resultsSelectAllMode/);
  });
});
