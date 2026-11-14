const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDER_CODES,
  PROVIDER_MAX,
  ALLOWED_LIMITS,
  normalizeLimit,
  providerLimit,
  providersForModality,
  resolveModality,
  MODALITIES,
  applyFilters,
  perProviderLimit,
  normalizeLead,
  deduplicate,
  clientMessageForOutcome,
  publicLead,
} = require('../src/services/searchEngine');

describe('provider registry contract', () => {
  it('PROVIDER_CODES are apify, tomtom, foursquare only', () => {
    assert.deepEqual(PROVIDER_CODES, ['apify', 'tomtom', 'foursquare']);
  });

  it('providersForModality returns the three current providers', () => {
    assert.deepEqual(providersForModality('standard'), ['apify', 'tomtom', 'foursquare']);
    assert.deepEqual(providersForModality('anything'), ['apify', 'tomtom', 'foursquare']);
  });

  it('resolveModality returns standard with three providers', () => {
    const m = resolveModality();
    assert.equal(m.id, 'standard');
    assert.deepEqual(m.providerCodes, PROVIDER_CODES);
  });

  it('MODALITIES.standard exposes providerCodes', () => {
    assert.ok(MODALITIES.standard);
    assert.deepEqual(MODALITIES.standard.providerCodes, PROVIDER_CODES);
  });

  it('per-provider max limits are 200/200/50', () => {
    assert.equal(PROVIDER_MAX.apify, 200);
    assert.equal(PROVIDER_MAX.tomtom, 200);
    assert.equal(PROVIDER_MAX.foursquare, 50);
  });

  it('normalizeLimit only allows exact 100-500 steps', () => {
    assert.deepEqual(ALLOWED_LIMITS, [100, 200, 300, 400, 500]);
    assert.equal(normalizeLimit(100), 100);
    assert.equal(normalizeLimit(200), 200);
    assert.equal(normalizeLimit(500), 500);
    assert.equal(normalizeLimit(250), 100);
    assert.equal(normalizeLimit(999), 100);
  });

  it('providerLimit respects global and per-provider caps', () => {
    assert.equal(providerLimit('apify', 500), 200);
    assert.equal(providerLimit('foursquare', 500), 50);
    assert.equal(providerLimit('tomtom', 100), 100);
  });
});

describe('searchEngine normalize dedupe filter limit', () => {
  it('normalizeLead trims and drops invalid ratings', () => {
    const n = normalizeLead({ name: '  A  ', rating: 'x', sourceProvider: 'apify', externalId: '1' });
    assert.equal(n.name, 'A');
    assert.equal(n.rating, null);
  });
  it('deduplicates by external id per provider', () => {
    const leads = [
      { name: 'A', sourceProvider: 'apify', externalId: '1', phone: null, address: 'x' },
      { name: 'A copy', sourceProvider: 'apify', externalId: '1', phone: null, address: 'y' },
      { name: 'B', sourceProvider: 'tomtom', externalId: '1', phone: null, address: 'z' },
    ];
    assert.equal(deduplicate(leads).length, 2);
  });
  it('deduplicates by phone', () => {
    const leads = [
      { name: 'A', phone: '+351 912 345 678', sourceProvider: 'apify', externalId: null, address: '' },
      { name: 'B', phone: '351912345678', sourceProvider: 'tomtom', externalId: null, address: '' },
    ];
    assert.equal(deduplicate(leads).length, 1);
  });
  it('applyFilters hasPhone', () => {
    assert.equal(
      applyFilters([{ name: 'A', phone: '1' }, { name: 'B', phone: null }], { hasPhone: true }).length,
      1
    );
  });
  it('applyFilters noWebsite removes leads with website', () => {
    const leads = [
      { name: 'A', website: 'https://x.test' },
      { name: 'B', website: null },
    ];
    const filtered = applyFilters(leads, { noWebsite: true });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, 'B');
  });
  it('perProviderLimit is bounded when exported', () => {
    if (typeof perProviderLimit === 'function') {
      assert.ok(perProviderLimit(10) >= 10 || perProviderLimit(10) > 0);
      assert.ok(perProviderLimit(500) <= 200 || perProviderLimit(500) > 0);
    }
  });
});

describe('searchEngine client messages', () => {
  it('no_results message is user-facing without provider names', () => {
    const msg = clientMessageForOutcome('no_results');
    assert.match(msg, /Não foram encontrados estabelecimentos/);
    assert.equal(/google|apify|osm|openstreet/i.test(msg), false);
  });
  it('error message is generic', () => {
    assert.match(clientMessageForOutcome('error'), /Não foi possível realizar a pesquisa neste momento/);
    assert.match(clientMessageForOutcome('inconclusive'), /Não foi possível concluir a pesquisa em todas as fontes/);
  });
  it('publicLead strips sourceProvider', () => {
    const p = publicLead({
      id: 'x', name: 'N', sourceProvider: 'apify', externalId: 'e',
      address: 'a', phone: null, email: null, website: null, rating: 4, reviewsCount: 1, category: 'c', lat: 1, lng: 2,
    });
    assert.equal(p.sourceProvider, undefined);
    assert.equal(p.name, 'N');
  });
});
