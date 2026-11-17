/**
 * Behaviour tests for bulk delete selection preservation.
 * Mirrors the algorithm used in public/js/app.js deleteSelectedLeads / deleteSelectedSearches.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BATCH = 500;

/**
 * Process one batch response for leads.
 * Mutates selection Set. Returns { totalDeletedDelta, remaining, stoppedEarly, message }.
 */
function processLeadsBatch(selection, remaining, batch, res) {
  if (!res || res.networkError) {
    batch.forEach((id) => selection.add(String(id)));
    remaining.forEach((id) => selection.add(String(id)));
    return {
      totalDeletedDelta: 0,
      remaining: remaining.slice(),
      stoppedEarly: true,
      reason: 'network',
    };
  }
  if (!res.ok) {
    batch.forEach((id) => selection.add(String(id)));
    remaining.forEach((id) => selection.add(String(id)));
    return {
      totalDeletedDelta: 0,
      remaining: remaining.slice(),
      stoppedEarly: true,
      reason: 'http',
    };
  }
  const deletedIds = (res.deletedIds || []).map(String);
  const deletedSet = new Set(deletedIds);
  deletedSet.forEach((id) => selection.delete(id));
  const notDeleted = batch.filter((id) => !deletedSet.has(String(id)));
  if (notDeleted.length) {
    notDeleted.forEach((id) => selection.add(String(id)));
    return {
      totalDeletedDelta: deletedSet.size,
      remaining: notDeleted.concat(remaining.slice(BATCH)),
      stoppedEarly: true,
      reason: 'partial',
    };
  }
  return {
    totalDeletedDelta: deletedSet.size,
    remaining: remaining.slice(BATCH),
    stoppedEarly: false,
    reason: 'ok',
  };
}

/**
 * Run full multi-batch leads delete simulation.
 * responses: array of response objects per batch attempt, consumed in order.
 */
function runLeadsDelete(allIds, responses) {
  const selection = new Set(allIds.map(String));
  let remaining = allIds.map(String);
  let totalDeleted = 0;
  let respIdx = 0;
  const log = [];
  while (remaining.length) {
    const batch = remaining.slice(0, BATCH);
    const res = responses[respIdx++];
    if (res === undefined) throw new Error('ran out of mock responses');
    const result = processLeadsBatch(selection, remaining, batch, res);
    totalDeleted += result.totalDeletedDelta;
    remaining = result.remaining;
    log.push(result.reason);
    if (result.stoppedEarly) break;
  }
  return {
    selected: Array.from(selection).sort(),
    totalDeleted,
    log,
  };
}

function processSearchesBatch(selection, remaining, batch, res) {
  if (!res || res.networkError) {
    batch.forEach((id) => selection.add(String(id)));
    remaining.forEach((id) => selection.add(String(id)));
    return {
      totalDeletedDelta: 0,
      totalSkippedDelta: [],
      remaining: remaining.slice(),
      stoppedEarly: true,
      reason: 'network',
    };
  }
  if (!res.ok && res.status !== 409) {
    batch.forEach((id) => selection.add(String(id)));
    remaining.forEach((id) => selection.add(String(id)));
    return {
      totalDeletedDelta: 0,
      totalSkippedDelta: [],
      remaining: remaining.slice(),
      stoppedEarly: true,
      reason: 'http',
    };
  }
  const deletedIds = (res.deletedIds || []).map(String);
  const skipped = (res.skippedRunning || []).map(String);
  const deletedSet = new Set(deletedIds);
  const skippedSet = new Set(skipped);
  deletedSet.forEach((id) => selection.delete(id));
  skipped.forEach((id) => selection.add(String(id)));
  const unresolved = batch.filter(
    (id) => !deletedSet.has(String(id)) && !skippedSet.has(String(id))
  );
  if (unresolved.length) {
    unresolved.forEach((id) => selection.add(String(id)));
    return {
      totalDeletedDelta: deletedSet.size,
      totalSkippedDelta: skipped,
      remaining: unresolved
        .concat(batch.filter((id) => skippedSet.has(String(id))))
        .concat(remaining.slice(BATCH)),
      stoppedEarly: true,
      reason: 'partial',
    };
  }
  return {
    totalDeletedDelta: deletedSet.size,
    totalSkippedDelta: skipped,
    remaining: remaining.slice(BATCH),
    stoppedEarly: false,
    reason: skipped.length ? 'ok-with-skips' : 'ok',
  };
}

function runSearchesDelete(allIds, responses) {
  const selection = new Set(allIds.map(String));
  let remaining = allIds.map(String);
  let totalDeleted = 0;
  let totalSkipped = [];
  let respIdx = 0;
  const log = [];
  while (remaining.length) {
    const batch = remaining.slice(0, BATCH);
    const res = responses[respIdx++];
    if (res === undefined) throw new Error('ran out of mock responses');
    const result = processSearchesBatch(selection, remaining, batch, res);
    totalDeleted += result.totalDeletedDelta;
    totalSkipped = totalSkipped.concat(result.totalSkippedDelta);
    remaining = result.remaining;
    log.push(result.reason);
    if (result.stoppedEarly) break;
  }
  return {
    selected: Array.from(selection).sort(),
    totalDeleted,
    totalSkipped: totalSkipped.slice().sort(),
    log,
  };
}

function makeIds(n, prefix) {
  return Array.from({ length: n }, (_, i) => prefix + String(i + 1).padStart(4, '0'));
}

describe('bulk delete leads — selection preservation', () => {
  it('1200 leads: three full batches remove everything', () => {
    const ids = makeIds(1200, 'L');
    const r = runLeadsDelete(ids, [
      { ok: true, deletedIds: ids.slice(0, 500) },
      { ok: true, deletedIds: ids.slice(500, 1000) },
      { ok: true, deletedIds: ids.slice(1000, 1200) },
    ]);
    assert.equal(r.totalDeleted, 1200);
    assert.deepEqual(r.selected, []);
    assert.deepEqual(r.log, ['ok', 'ok', 'ok']);
  });

  it('HTTP failure on first batch keeps all selected', () => {
    const ids = makeIds(1200, 'L');
    const r = runLeadsDelete(ids, [{ ok: false, status: 500 }]);
    assert.equal(r.totalDeleted, 0);
    assert.equal(r.selected.length, 1200);
    assert.deepEqual(r.selected, ids.map(String).sort());
    assert.deepEqual(r.log, ['http']);
  });

  it('HTTP failure on second batch after first success keeps remaining selected', () => {
    const ids = makeIds(1200, 'L');
    const r = runLeadsDelete(ids, [
      { ok: true, deletedIds: ids.slice(0, 500) },
      { ok: false, status: 500 },
    ]);
    assert.equal(r.totalDeleted, 500);
    const expected = ids.slice(500).map(String).sort();
    assert.deepEqual(r.selected, expected);
    assert.equal(r.selected.length, 700);
    assert.deepEqual(r.log, ['ok', 'http']);
  });

  it('network exception on first batch keeps all selected', () => {
    const ids = makeIds(800, 'L');
    const r = runLeadsDelete(ids, [{ networkError: true }]);
    assert.equal(r.totalDeleted, 0);
    assert.equal(r.selected.length, 800);
    assert.deepEqual(r.log, ['network']);
  });

  it('network exception after successful batch keeps pending selected', () => {
    const ids = makeIds(1200, 'L');
    const r = runLeadsDelete(ids, [
      { ok: true, deletedIds: ids.slice(0, 500) },
      { networkError: true },
    ]);
    assert.equal(r.totalDeleted, 500);
    assert.deepEqual(r.selected, ids.slice(500).map(String).sort());
    assert.deepEqual(r.log, ['ok', 'network']);
  });

  it('partial response removes only confirmed deletedIds and stops', () => {
    const ids = makeIds(600, 'L');
    const deleted = ids.slice(0, 300);
    const r = runLeadsDelete(ids, [
      { ok: true, deletedIds: deleted },
    ]);
    assert.equal(r.totalDeleted, 300);
    const expected = ids.slice(300).map(String).sort();
    assert.deepEqual(r.selected, expected);
    assert.deepEqual(r.log, ['partial']);
  });

  it('no duplicate ids after recovery from HTTP failure', () => {
    const ids = makeIds(50, 'L');
    const selection = new Set(ids.map(String));
    const remaining = ids.map(String);
    const batch = remaining.slice(0, BATCH);
    processLeadsBatch(selection, remaining, batch, { ok: false, status: 500 });
    assert.equal(selection.size, 50);
    assert.deepEqual(Array.from(selection).sort(), ids.map(String).sort());
  });
});

describe('bulk delete searches — selection preservation', () => {
  it('1200 searches: three full batches remove everything', () => {
    const ids = makeIds(1200, 'S');
    const r = runSearchesDelete(ids, [
      { ok: true, deletedIds: ids.slice(0, 500), skippedRunning: [] },
      { ok: true, deletedIds: ids.slice(500, 1000), skippedRunning: [] },
      { ok: true, deletedIds: ids.slice(1000, 1200), skippedRunning: [] },
    ]);
    assert.equal(r.totalDeleted, 1200);
    assert.deepEqual(r.selected, []);
  });

  it('HTTP failure on first batch keeps all selected', () => {
    const ids = makeIds(100, 'S');
    const r = runSearchesDelete(ids, [{ ok: false, status: 500 }]);
    assert.equal(r.totalDeleted, 0);
    assert.equal(r.selected.length, 100);
  });

  it('network exception after success keeps pending selected', () => {
    const ids = makeIds(600, 'S');
    const r = runSearchesDelete(ids, [
      { ok: true, deletedIds: ids.slice(0, 500), skippedRunning: [] },
      { networkError: true },
    ]);
    assert.equal(r.totalDeleted, 500);
    assert.deepEqual(r.selected, ids.slice(500).map(String).sort());
  });

  it('running searches stay selected and do not block remaining batches', () => {
    const ids = makeIds(3, 'S');
    const r = runSearchesDelete(ids, [
      {
        ok: true,
        deletedIds: [ids[0], ids[2]],
        skippedRunning: [ids[1]],
      },
    ]);
    assert.equal(r.totalDeleted, 2);
    assert.deepEqual(r.selected, [ids[1]].map(String).sort());
    assert.deepEqual(r.totalSkipped, [ids[1]].map(String).sort());
    assert.deepEqual(r.log, ['ok-with-skips']);
  });

  it('partial unresolved ids stop processing and stay selected', () => {
    const ids = makeIds(10, 'S');
    const r = runSearchesDelete(ids, [
      {
        ok: true,
        deletedIds: ids.slice(0, 4),
        skippedRunning: [ids[5]],
      },
    ]);
    assert.equal(r.totalDeleted, 4);
    const expected = ids.slice(4).map(String).sort();
    assert.deepEqual(r.selected, expected);
    assert.deepEqual(r.log, ['partial']);
  });
});

describe('app.js contracts for bulk delete selection', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');

  it('deleteSelectedLeads only removes confirmed deletedIds', () => {
    const start = appJs.indexOf('async function deleteSelectedLeads');
    const end = appJs.indexOf('async function deleteAllLeads');
    const snip = appJs.slice(start, end);
    assert.match(snip, /deletedSet\.forEach/);
    assert.doesNotMatch(snip, /batch\.forEach\(\(id\) => selectedLeadIds\.delete/);
    assert.match(snip, /notDeleted/);
    assert.match(snip, /remaining\.slice\(0,\s*BATCH\)/);
  });

  it('deleteSelectedLeads restores selection on network error', () => {
    const start = appJs.indexOf('async function deleteSelectedLeads');
    const end = appJs.indexOf('async function deleteAllLeads');
    const snip = appJs.slice(start, end);
    assert.match(snip, /Erro de rede ao eliminar leads/);
    assert.match(snip, /selectedLeadIds\.add/);
  });

  it('deleteSelectedSearches uses deletedIds and skippedRunning correctly', () => {
    const start = appJs.indexOf('async function deleteSelectedSearches');
    const end = appJs.indexOf('async function deleteAllSearches');
    const snip = appJs.slice(start, end);
    assert.match(snip, /deletedSet\.forEach/);
    assert.match(snip, /skippedRunning/);
    assert.match(snip, /unresolved/);
  });
});
