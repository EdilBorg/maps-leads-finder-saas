const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveModality,
  providersForModality,
  deduplicate,
  applyFilters,
  clientMessageForOutcome,
  publicLead,
} = require('../src/services/searchEngine');

describe('searchEngine modalities', () => {
  it('standard maps to google_maps + osm only', () => {
    assert.deepEqual(providersForModality('standard'), ['google_maps', 'osm']);
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
    assert.equal(s.length, 2);
    assert.equal(e.length, 2);
  });
});

describe('searchEngine dedupe and filters', () => {
  it('deduplicates by external id per provider', () => {
    const leads = [
      { name: 'A', sourceProvider: 'google_maps', externalId: '1', phone: null, address: 'x' },
      { name: 'A copy', sourceProvider: 'google_maps', externalId: '1', phone: null, address: 'y' },
      { name: 'B', sourceProvider: 'osm', externalId: '1', phone: null, address: 'z' },
    ];
    const out = deduplicate(leads);
    assert.equal(out.length, 2);
  });

  it('deduplicates by phone', () => {
    const leads = [
      { name: 'A', phone: '+351 912 345 678', sourceProvider: 'google_maps', externalId: null, address: '' },
      { name: 'B', phone: '351912345678', sourceProvider: 'osm', externalId: null, address: '' },
    ];
    assert.equal(deduplicate(leads).length, 1);
  });

  it('applyFilters hasPhone', () => {
    const leads = [
      { name: 'A', phone: '1' },
      { name: 'B', phone: null },
    ];
    assert.equal(applyFilters(leads, { hasPhone: true }).length, 1);
  });
});

describe('searchEngine client messages', () => {
  it('no_results message is user-facing without provider names', () => {
    const msg = clientMessageForOutcome('no_results');
    assert.equal(msg, 'Nenhum resultado encontrado.');
    assert.equal(/google|apify|osm|openstreet/i.test(msg), false);
  });

  it('error message is generic', () => {
    const msg = clientMessageForOutcome('error');
    assert.match(msg, /Não foi possível realizar a pesquisa/);
  });

  it('publicLead strips sourceProvider', () => {
    const p = publicLead({
      id: 'x',
      name: 'N',
      sourceProvider: 'google_maps',
      externalId: 'e',
      address: 'a',
      phone: null,
      email: null,
      website: null,
      rating: 4,
      reviewsCount: 1,
      category: 'c',
      lat: 1,
      lng: 2,
    });
    assert.equal(p.sourceProvider, undefined);
    assert.equal(p.name, 'N');
  });
});
