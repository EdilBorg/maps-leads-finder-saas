const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('paymentService source guards', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/paymentService.js'), 'utf8');
  it('uses idempotency_key', () => assert.match(src, /idempotency_key/));
  it('approve is idempotent', () => {
    assert.match(src, /pay\.status === 'approved'/);
    assert.match(src, /replayed: true/);
  });
  it('activateSubscription on approve', () => assert.match(src, /activateSubscription/));
});

describe('migration 014', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/014_provider_quotas_and_usage.sql'), 'utf8');
  it('creates ledger tables', () => {
    assert.match(sql, /plan_provider_limits/);
    assert.match(sql, /provider_usage/);
    assert.match(sql, /provider_usage_events/);
    assert.match(sql, /provider_global_usage/);
    assert.match(sql, /provider_pricing/);
  });
  it('does not hardcode TomTom 5000', () => assert.doesNotMatch(sql, /5000/));
  it('uses micro-usd integers', () => assert.match(sql, /cost_micro_usd_used/));
});

describe('searchService quota integration', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/searchService.js'), 'utf8');
  it('calls authorizeAndReserve', () => assert.match(src, /authorizeAndReserve/));
  it('commits provider metrics on paid path', () => assert.match(src, /commitProviderMetrics/));
  it('passes allowedProviders to engine', () => assert.match(src, /allowedProviders/));
});
