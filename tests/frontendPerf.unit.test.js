const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

describe('frontend load performance patterns', () => {
  it('bootstraps after auth before dashboard', () => {
    assert.match(app, /async function bootstrap\s*\(/);
    assert.match(app, /await refreshAuthUi\s*\(/);
    assert.match(app, /appBootstrapped/);
    const boot = app.slice(app.indexOf('async function bootstrap'), app.indexOf('async function bootstrap') + 500);
    assert.ok(boot.indexOf('await refreshAuthUi') < boot.indexOf("showView('dashboard')"));
  });

  it('uses dashboard generation seq for concurrency', () => {
    assert.match(app, /DASHBOARD_TTL_MS\s*=\s*10000/);
    assert.match(app, /dashboardSeq/);
    assert.match(app, /dashboardInFlightSeq/);
    assert.match(app, /invalidateDashboardCache/);
    assert.match(app, /requestSeq !== dashboardSeq/);
    assert.match(app, /loadDashboard\(\{\s*force:\s*true\s*\}\)/);
  });

  it('loads plans quota/plans/payments in parallel', () => {
    const i = app.indexOf('async function loadPlansQuotaViewBody');
    const body = app.slice(i, i + 4000);
    assert.match(body, /Promise\.all\s*\(/);
    assert.match(body, /\/api\/billing\/quota/);
    assert.match(body, /\/api\/billing\/plans/);
    assert.match(body, /\/api\/billing\/payments/);
  });

  it('dedupes concurrent plans and settings loads with finally cleanup', () => {
    assert.match(app, /plansInFlight/);
    assert.match(app, /settingsInFlight/);
    assert.match(app, /plansInFlight = loadPlansQuotaViewBody\(\)\.finally/);
    assert.match(app, /settingsInFlight = loadSettingsBody\(\)\.finally/);
  });

  it('invalidates dashboard after successful search and search deletes', () => {
    assert.match(app, /loadDashboard\(\{\s*force:\s*true\s*\}\)[\s\S]{0,80}outcome:\s*'success'/);
    assert.match(app, /Pesquisa eliminada\.[\s\S]{0,300}loadDashboard\(\{\s*force:\s*true/);
    assert.match(app, /loadHistory\(\{\s*scrollToTop:\s*true\s*\}\)[\s\S]{0,120}loadDashboard\(\{\s*force:\s*true/);
  });

  it('only forces dashboard after save when leads were actually saved', () => {
    assert.match(app, /saved > 0 && typeof loadDashboard === 'function'/);
  });
});

function createDashboardController(fetchFn, ttlMs) {
  let cache = null;
  let inFlight = null;
  let inFlightSeq = 0;
  let seq = 0;
  let rendered = [];

  function invalidate() {
    cache = null;
    seq += 1;
  }

  async function load(opts) {
    const force = !!(opts && opts.force);
    if (force) invalidate();
    if (!force && cache && (Date.now() - cache.at) < ttlMs) {
      rendered.push({ from: 'cache', data: cache.data, seq });
      return cache.data;
    }
    if (!force && inFlight && inFlightSeq === seq) {
      return inFlight;
    }
    const requestSeq = seq;
    const promise = (async () => {
      try {
        const data = await fetchFn(requestSeq);
        if (requestSeq !== seq) return null;
        cache = { at: Date.now(), data };
        rendered.push({ from: 'network', data, seq: requestSeq });
        return data;
      } finally {
        if (inFlightSeq === requestSeq) inFlight = null;
      }
    })();
    inFlight = promise;
    inFlightSeq = requestSeq;
    return promise;
  }

  return { load, invalidate, getRendered: () => rendered.slice(), getSeq: () => seq, getCache: () => cache };
}

describe('dashboard concurrency protocol', () => {
  it('serves cache within TTL for normal loads', async () => {
    let calls = 0;
    const c = createDashboardController(async () => {
      calls += 1;
      return { n: calls };
    }, 10000);
    await c.load();
    await c.load();
    assert.equal(calls, 1);
    assert.equal(c.getRendered().filter((r) => r.from === 'cache').length, 1);
  });

  it('force bumps seq and fetches fresh data ignoring stale in-flight', async () => {
    let resolveSlow;
    const slow = new Promise((r) => { resolveSlow = r; });
    let calls = 0;
    const c = createDashboardController(async (reqSeq) => {
      calls += 1;
      if (calls === 1) {
        await slow;
        return { n: 1, reqSeq };
      }
      return { n: 2, reqSeq };
    }, 10000);

    const p1 = c.load();
    const p2 = c.load({ force: true });
    resolveSlow();
    const r1 = await p1;
    const r2 = await p2;
    assert.equal(r1, null);
    assert.deepEqual(r2, { n: 2, reqSeq: c.getSeq() });
    const net = c.getRendered().filter((r) => r.from === 'network');
    assert.equal(net.length, 1);
    assert.equal(net[0].data.n, 2);
  });

  it('two concurrent normal loads share one in-flight request', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const c = createDashboardController(async () => {
      calls += 1;
      await gate;
      return { n: calls };
    }, 10000);
    const a = c.load();
    const b = c.load();
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.deepEqual(ra, rb);
  });

  it('invalidate without force clears cache so next load hits network', async () => {
    let calls = 0;
    const c = createDashboardController(async () => {
      calls += 1;
      return { n: calls };
    }, 10000);
    await c.load();
    c.invalidate();
    await c.load();
    assert.equal(calls, 2);
  });

  it('stale response after newer force does not overwrite cache', async () => {
    const resolvers = [];
    let calls = 0;
    const c = createDashboardController(async (reqSeq) => {
      calls += 1;
      const my = calls;
      await new Promise((r) => resolvers.push({ r, my, reqSeq }));
      return { n: my, reqSeq };
    }, 10000);

    const p1 = c.load();
    const p2 = c.load({ force: true });
    const second = resolvers.find((x) => x.my === 2);
    const first = resolvers.find((x) => x.my === 1);
    second.r();
    await p2;
    first.r();
    await p1;
    assert.equal(c.getCache().data.n, 2);
  });
});
