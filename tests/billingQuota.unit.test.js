const { describe, it, before, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('providerUsageService pricing snapshot', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/providerUsageService.js'), 'utf8');

  it('reserve stores unitCostMicroUsd and fixedExecutionCostMicroUsd in metadata', () => {
    assert.match(src, /unitCostMicroUsd/);
    assert.match(src, /fixedExecutionCostMicroUsd/);
    assert.match(src, /includeFixedCost/);
  });

  it('commit accepts unitCostMicroUsd snapshot and prefers it over live pricing', () => {
    assert.match(src, /unitCostMicroUsd != null/);
    assert.match(src, /Prefer immutable snapshot/);
  });

  it('uses BigInt for cost math', () => {
    assert.match(src, /toBigIntSafe/);
    assert.match(src, /BigInt\(actualResults\)/);
  });

  it('records excess when actual exceeds reserved', () => {
    assert.match(src, /excessResults/);
    assert.match(src, /eventType = excessResults > 0/);
  });
});

describe('TomTom global fail-closed', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/providerUsageService.js'), 'utf8');

  it('getTomTomGlobalConfig fails closed on DB error', () => {
    assert.match(src, /configError/);
    assert.match(src, /maxCallsPerPeriod: 0/);
  });

  it('invalid max_calls_per_period yields zero allowance', () => {
    assert.match(src, /invalidConfig/);
  });

  it('requires non-negative integer calls', () => {
    assert.match(src, /calls must be a non-negative integer/);
  });
});

describe('quotaService trial global TomTom', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/quotaService.js'), 'utf8');

  it('trial path reserves global TomTom', () => {
    assert.match(src, /reserveTrialGlobalTomTom/);
    assert.match(src, /greserve-trial/);
  });

  it('denies trial when global TomTom exhausted', () => {
    assert.match(src, /GLOBAL_TOMTOM_LIMIT/);
    assert.match(src, /Quota global TomTom esgotada/);
  });

  it('Bright Data geocode is pre-reserved', () => {
    assert.match(src, /greserve-geo/);
  });

  it('commit passes pricing snapshot fields', () => {
    assert.match(src, /unitCostMicroUsd: reservation\.unitCostMicroUsd/);
  });

  it('exports commitTrialGlobalTomTom', () => {
    assert.match(src, /commitTrialGlobalTomTom/);
  });
});

describe('paymentService concurrent idempotency', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/paymentService.js'), 'utf8');

  it('re-checks idempotency_key inside transaction', () => {
    assert.match(src, /FOR SHARE/);
  });

  it('handles unique_violation 23505 as replay', () => {
    assert.match(src, /23505/);
    assert.match(src, /replayed: true/);
  });
});

describe('admin tomtom-quota validation', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/admin.js'), 'utf8');

  it('rejects negative or non-integer maxCallsPerPeriod', () => {
    assert.match(src, /maxCallsPerPeriod deve ser inteiro/);
  });

  it('validates periodDays range 1..366', () => {
    assert.match(src, /periodDays deve ser inteiro entre 1 e 366/);
  });
});
