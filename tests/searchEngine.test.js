const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveModality,
  providersForModality,
  normalizeLead,
  deduplicate,
  applyFilters,
  perProviderLimit,
  clientMessageForOutcome,
  publicLead,
} = require('../src/services/searchEngine');

describe('searchEngine modalities', () => {
  it('standard maps to google_maps + osm only', () => {
    assert.deepEqual(providersForModality('standard'), ['google_maps', 'osm']);
    assert.equal(resolveModality('standard').id, 'standard');
  });
  it('expanded maps to google_maps + apify only', () => {
    assert.deepEqual(providersForModality('expanded'), ['google_maps', 'apify']);
  });
  it('unknown modality falls back to standard', () => {
    assert.equal(resolveModality('other').id, 'standard');
  });
  it('never uses all three providers together', () => {
    const s = providersForModality('standard');
    const e = providersForModality('expanded');
    assert.equal(s.includes('apify'), false);
    assert.equal(e.includes('osm'), false);
  });
});

describe('searchEngine normalize dedupe filter limit', () => {
  it('normalizeLead trims and drops invalid ratings', () => {
    const n = normalizeLead({ name: '  A  ', rating: 'x', sourceProvider: 'osm', externalId: '1' });
    assert.equal(n.name, 'A');
    assert.equal(n.rating, null);
  });
  it('deduplicates by external id per provider', () => {
    const leads = [
      { name: 'A', sourceProvider: 'google_maps', externalId: '1', phone: null, address: 'x' },
      { name: 'A copy', sourceProvider: 'google_maps', externalId: '1', phone: null, address: 'y' },
      { name: 'B', sourceProvider: 'osm', externalId: '1', phone: null, address: 'z' },
    ];
    assert.equal(deduplicate(leads).length, 2);
  });
  it('deduplicates by phone', () => {
    const leads = [
      { name: 'A', phone: '+351 912 345 678', sourceProvider: 'google_maps', externalId: null, address: '' },
      { name: 'B', phone: '351912345678', sourceProvider: 'osm', externalId: null, address: '' },
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
  it('applyFilters noWebsite false keeps websites', () => {
    assert.equal(
      applyFilters([{ name: 'A', website: 'https://x.test' }], { noWebsite: false }).length,
      1
    );
  });
  it('perProviderLimit is bounded', () => {
    assert.ok(perProviderLimit(10) >= 10);
    assert.ok(perProviderLimit(500) <= 200);
  });
  it('global limit applied after merge via slice contract', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      normalizeLead({ name: `N${i}`, sourceProvider: 'osm', externalId: String(i) })
    );
    assert.equal(deduplicate(many).slice(0, 15).length, 15);
  });
});

describe('searchEngine client messages', () => {
  it('no_results message is user-facing without provider names', () => {
    const msg = clientMessageForOutcome('no_results');
    assert.match(msg, /Não foram encontrados estabelecimentos/);
    assert.match(msg, /categoria ou a localização/);
    assert.equal(/google|apify|osm|openstreet/i.test(msg), false);
  });
  it('error message is generic', () => {
    assert.match(clientMessageForOutcome('error'), /Não foi possível realizar a pesquisa neste momento/);
    assert.match(clientMessageForOutcome('inconclusive'), /Não foi possível concluir a pesquisa em todas as fontes/);
  });
  it('publicLead strips sourceProvider', () => {
    const p = publicLead({
      id: 'x', name: 'N', sourceProvider: 'google_maps', externalId: 'e',
      address: 'a', phone: null, email: null, website: null, rating: 4, reviewsCount: 1, category: 'c', lat: 1, lng: 2,
    });
    assert.equal(p.sourceProvider, undefined);
    assert.equal(p.name, 'N');
  });
});
