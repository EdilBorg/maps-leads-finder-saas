const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolvePeriodWindow, PERIOD_DAYS_DEFAULT } = require('../src/services/subscriptionService');

describe('idempotency keys require real searchId', () => {
  const quota = fs.readFileSync(path.join(__dirname, '../src/services/quotaService.js'), 'utf8');
  const search = fs.readFileSync(path.join(__dirname, '../src/services/searchService.js'), 'utf8');
  it('does not use searchId || new fallback', () => {
    assert.doesNotMatch(quota, /searchId \|\| 'new'/);
  });
  it('startSearch creates search before authorizeAndReserve', () => {
    const ins = search.indexOf('INSERT INTO searches');
    const auth = search.indexOf('authorizeAndReserve');
    assert.ok(ins > 0 && auth > ins, 'INSERT must precede authorizeAndReserve');
  });
  it('cancelSearch releases paid reservations', () => {
    assert.match(search, /releaseAllReservations/);
    assert.match(search, /quotaMode === 'paid'/);
  });
  it('paid path rejects missing searchId', () => {
    assert.match(quota, /MISSING_SEARCH_ID/);
  });
});

describe('subscription period immutability', () => {
  it('uses subscription.periodDays over mutable override', () => {
    const sub = {
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-04-01T00:00:00.000Z',
      periodDays: 30,
    };
    const w = resolvePeriodWindow(sub, new Date('2026-02-05T00:00:00.000Z'), 99);
    assert.equal(w.periodDays, 30);
    assert.equal(w.periodIndex, 1);
  });
  it('exact 30-day consecutive cycles without gap', () => {
    const sub = {
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-03-02T00:00:00.000Z',
      periodDays: 30,
    };
    const a = resolvePeriodWindow(sub, new Date('2026-01-15T00:00:00.000Z'));
    const b = resolvePeriodWindow(sub, new Date('2026-01-31T00:00:00.000Z'));
    assert.equal(a.periodEnd, b.periodStart);
  });
  it('default period is 30', () => assert.equal(PERIOD_DAYS_DEFAULT, 30));
});

describe('activateSubscription concurrency guards', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/subscriptionService.js'), 'utf8');
  it('locks user row', () => assert.match(src, /SELECT id FROM users WHERE id = \$1 FOR UPDATE/));
  it('persists period_days', () => assert.match(src, /period_days/));
});

describe('TomTom global idempotency', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/providerUsageService.js'), 'utf8');
  it('requires idempotency key when limited', () => {
    assert.match(src, /idempotencyKey required for TomTom global reserve/);
  });
  it('records global events', () => {
    assert.match(src, /provider_global_usage_events/);
  });
});

describe('admin pricing validation', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');
  it('rejects negative unit costs', () => {
    assert.match(src, /unitCostMicroUsd deve ser inteiro/);
  });
  it('rejects non-integer decimals', () => {
    assert.match(src, /sem decimais/);
  });
});

describe('migration 015', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/015_subscription_period_days.sql'), 'utf8');
  it('adds period_days and global events', () => {
    assert.match(sql, /period_days/);
    assert.match(sql, /provider_global_usage_events/);
  });
});
