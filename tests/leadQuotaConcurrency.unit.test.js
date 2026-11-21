const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const searchJs = fs.readFileSync(path.join(root, 'src/services/searchService.js'), 'utf8');
const quotaJs = fs.readFileSync(path.join(root, 'src/services/quotaService.js'), 'utf8');
const leadJs = fs.readFileSync(path.join(root, 'src/services/leadQuotaService.js'), 'utf8');

describe('searchService startSearch lock order', () => {
  it('locks user immediately after BEGIN before insert/authorize', () => {
    const i = searchJs.indexOf('async function startSearch');
    const body = searchJs.slice(i, i + 2500);
    const begin = body.indexOf("query('BEGIN')");
    const lock = body.indexOf('lockUserForUpdate');
    const ins = body.indexOf('INSERT INTO searches');
    const auth = body.indexOf('authorizeAndReserve');
    assert.ok(begin >= 0 && lock > begin);
    assert.ok(ins > lock);
    assert.ok(auth > ins);
  });

  it('does not bump paid finalLimit via normalizeLimit', () => {
    const i = searchJs.indexOf('holdToken = auth.holdToken');
    const body = searchJs.slice(i, i + 500);
    assert.match(body, /auth\.mode === 'trial'/);
    assert.match(body, /Math\.min\(Number\(auth\.limit\),\s*500\)/);
    assert.doesNotMatch(body, /normalizeLimit\(Math\.min\(auth\.limit/);
  });

  it('hard-fails on lead quota commit errors (no swallow)', () => {
    const i = searchJs.indexOf("if (ctx.quotaMode === 'paid')");
    // find the persist block with commitLeadQuota
    const j = searchJs.indexOf('commitLeadQuota');
    const body = searchJs.slice(j - 200, j + 400);
    assert.match(body, /commitLeadQuota/);
    assert.doesNotMatch(body, /catch \(lqErr\)/);
  });

  it('caps persisted leads to reservation', () => {
    assert.match(searchJs, /leadQuotaReserved/);
    assert.match(searchJs, /leadsToPersist\.slice\(0,\s*maxAllowed\)/);
  });
});

describe('getClientQuotaView period variable', () => {
  it('uses period.periodStart for reserved leads lookup', () => {
    const i = quotaJs.indexOf('async function getClientQuotaView');
    const body = quotaJs.slice(i, i + 8000);
    assert.match(body, /reservedLeads = await leadQuotaService\.getReservedForUser\(userId, period\.periodStart\)/);
    assert.doesNotMatch(body, /getReservedForUser\(userId, window\.periodStart\)/);
  });

  it('does not silently zero reserved on error', () => {
    assert.match(quotaJs, /QUOTA_VIEW_RESERVED_FAILED/);
    const i = quotaJs.indexOf('async function getClientQuotaView');
    const body = quotaJs.slice(i, i + 8000);
    assert.doesNotMatch(body, /catch \(_\) \{ reservedLeads = 0; \}/);
  });
});

describe('commitLeadQuota strictness', () => {
  it('rejects over-delivery', () => {
    assert.match(leadJs, /LEAD_QUOTA_OVER_DELIVERY/);
    assert.doesNotMatch(
      leadJs.slice(leadJs.indexOf('async function commitLeadQuota'), leadJs.indexOf('async function releaseLeadQuota')),
      /Math\.min\(Number\(deliveredCount\)/
    );
  });
});

/**
 * Pure concurrent reservation simulator (mirrors lead_quota_holds math).
 */
function createQuotaSimulator(planLimit) {
  let delivered = 0;
  let holds = new Map(); // searchId -> reserved
  let seq = 0;

  function available() {
    let reserved = 0;
    for (const v of holds.values()) reserved += v;
    return Math.max(0, planLimit - delivered - reserved);
  }

  function reserve(searchId, want) {
    const av = available();
    if (av <= 0) return { ok: false, reason: 'QUOTA_EXHAUSTED' };
    const n = Math.min(want, av);
    holds.set(searchId, n);
    return { ok: true, reserved: n, available: available() };
  }

  function commit(searchId, n) {
    const r = holds.get(searchId);
    if (r == null) throw new Error('MISSING_HOLD');
    if (n > r) throw new Error('OVER_DELIVERY');
    delivered += n;
    holds.delete(searchId);
    return { committed: n };
  }

  function release(searchId) {
    holds.delete(searchId);
  }

  return { available, reserve, commit, release, getDelivered: () => delivered };
}

describe('concurrent commercial quota simulation', () => {
  it('two concurrent reserves never exceed 2500', () => {
    const q = createQuotaSimulator(2500);
    const a = q.reserve('s1', 2000);
    const b = q.reserve('s2', 2000);
    assert.equal(a.ok, true);
    assert.equal(a.reserved, 2000);
    assert.equal(b.ok, true);
    assert.equal(b.reserved, 500);
    assert.equal(a.reserved + b.reserved, 2500);
    assert.equal(q.available(), 0);
  });

  it('partial remaining is exact', () => {
    const q = createQuotaSimulator(2500);
    q.reserve('s1', 2450);
    const b = q.reserve('s2', 500);
    assert.equal(b.reserved, 50);
  });

  it('commit matches persisted count and frees unused', () => {
    const q = createQuotaSimulator(2500);
    q.reserve('s1', 500);
    q.commit('s1', 350);
    assert.equal(q.getDelivered(), 350);
    assert.equal(q.available(), 2150);
  });

  it('over-delivery throws', () => {
    const q = createQuotaSimulator(2500);
    q.reserve('s1', 100);
    assert.throws(() => q.commit('s1', 101), /OVER_DELIVERY/);
  });

  it('release restores capacity', () => {
    const q = createQuotaSimulator(2500);
    q.reserve('s1', 800);
    q.release('s1');
    assert.equal(q.available(), 2500);
  });

  it('replay commit does not double-count when already committed externally', () => {
    const q = createQuotaSimulator(2500);
    q.reserve('s1', 100);
    q.commit('s1', 100);
    assert.equal(q.getDelivered(), 100);
    // second commit without hold throws
    assert.throws(() => q.commit('s1', 100), /MISSING_HOLD/);
  });
});
