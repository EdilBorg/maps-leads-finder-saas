const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePeriodWindow } = require('../src/services/subscriptionService');

describe('subscription resolvePeriodWindow (30-day cycles UTC)', () => {
  it('returns first period at activation', () => {
    const sub = { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-03-01T00:00:00.000Z' };
    const w = resolvePeriodWindow(sub, new Date('2026-01-15T12:00:00.000Z'), 30);
    assert.equal(w.periodIndex, 0);
    assert.equal(w.periodStart, '2026-01-01T00:00:00.000Z');
  });
  it('moves to second period after 30 days', () => {
    const sub = { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-04-01T00:00:00.000Z' };
    const w = resolvePeriodWindow(sub, new Date('2026-02-05T00:00:00.000Z'), 30);
    assert.equal(w.periodIndex, 1);
  });
  it('returns null when expired', () => {
    const sub = { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-20T00:00:00.000Z' };
    assert.equal(resolvePeriodWindow(sub, new Date('2026-01-21T00:00:00.000Z'), 30), null);
  });
  it('uses exact 30-day windows from starts_at', () => {
    const sub = { startsAt: '2026-01-15T00:00:00.000Z', endsAt: '2026-04-15T00:00:00.000Z' };
    assert.equal(resolvePeriodWindow(sub, new Date('2026-02-13T00:00:00.000Z'), 30).periodIndex, 0);
    assert.equal(resolvePeriodWindow(sub, new Date('2026-02-14T00:00:00.000Z'), 30).periodIndex, 1);
  });
});
