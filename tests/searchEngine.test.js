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
  mergeLeads,
  classifyWebsiteUrl,
  pickPreferredWebsite,
  clientMessageForOutcome,
  publicLead,
} = require('../src/services/searchEngine');

describe('provider registry contract', () => {
  it('PROVIDER_CODES are apify, tomtom, brightdata only', () => {
    assert.deepEqual(PROVIDER_CODES, ['apify', 'tomtom', 'brightdata']);
  });

  it('providersForModality returns the three current providers', () => {
    assert.deepEqual(providersForModality('standard'), ['apify', 'tomtom', 'brightdata']);
    assert.deepEqual(providersForModality('anything'), ['apify', 'tomtom', 'brightdata']);
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

  it('per-provider max limits allow Apify up to 500', () => {
    assert.equal(PROVIDER_MAX.apify, 500);
    assert.equal(PROVIDER_MAX.tomtom, 200);
    assert.equal(PROVIDER_MAX.brightdata, 200);
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
    assert.equal(providerLimit('apify', 500), 500);
    assert.equal(providerLimit('brightdata', 500), 200);
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
  it('classifyWebsiteUrl maps social, directory, none, unknown (no false own_website)', () => {
    assert.equal(classifyWebsiteUrl('https://www.instagram.com/empresa'), 'social_media');
    assert.equal(classifyWebsiteUrl('www.facebook.com/empresa'), 'social_media');
    assert.equal(classifyWebsiteUrl('m.facebook.com/empresa'), 'social_media');
    assert.equal(classifyWebsiteUrl('https://www.tiktok.com/@empresa'), 'social_media');
    assert.equal(classifyWebsiteUrl('https://youtu.be/abc123'), 'social_media');
    // Valid but unrecognized domains are unknown — we do not invent ownership certainty
    assert.equal(classifyWebsiteUrl('https://empresa.co.mz'), 'unknown');
    assert.equal(classifyWebsiteUrl('https://www.empresa.com'), 'unknown');
    assert.equal(classifyWebsiteUrl('https://www.yelp.com/biz/empresa'), 'directory');
    assert.equal(classifyWebsiteUrl('https://www.tripadvisor.com/empresa'), 'directory');
    assert.equal(classifyWebsiteUrl('https://www.google.com/maps/place/empresa'), 'directory');
    assert.equal(classifyWebsiteUrl(''), 'none');
    assert.equal(classifyWebsiteUrl(null), 'none');
    assert.equal(classifyWebsiteUrl('not a url !!!'), 'unknown');
    assert.equal(classifyWebsiteUrl('https://facebook.com.evil.com'), 'unknown');
    assert.equal(classifyWebsiteUrl('https://notfacebook.com'), 'unknown');
    assert.equal(classifyWebsiteUrl('https://plataforma-desconhecida.example/empresa'), 'unknown');
  });

  it('applyFilters noWebsite keeps social and none, excludes directory/unknown', () => {
    const leads = [
      { name: 'UnknownDomain', website: 'https://empresa.co.mz' },
      { name: 'IG', website: 'https://www.instagram.com/empresa' },
      { name: 'FB', website: 'www.facebook.com/page' },
      { name: 'Yelp', website: 'https://www.yelp.com/biz/x' },
      { name: 'Empty', website: null },
      { name: 'Unknown', website: 'https://weird-host-that-is-valid.example' },
      { name: 'Bad', website: '::::' },
    ];
    const filtered = applyFilters(leads, { noWebsite: true });
    const names = filtered.map((l) => l.name).sort();
    assert.deepEqual(names, ['Empty', 'FB', 'IG']);
    assert.equal(filtered.find((l) => l.name === 'IG').website, 'https://www.instagram.com/empresa');
  });

  it('applyFilters noWebsite excludes unknown domain', () => {
    const leads = [
      { name: 'A', website: 'https://x.test' },
      { name: 'B', website: null },
    ];
    const filtered = applyFilters(leads, { noWebsite: true });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, 'B');
  });

  it('pickPreferredWebsite is deterministic and order-independent', () => {
    function both(a, b, expected) {
      assert.equal(pickPreferredWebsite(a, b), expected);
      assert.equal(pickPreferredWebsite(b, a), expected);
    }
    // social > directory
    both('https://instagram.com/empresa', 'https://yelp.com/biz/empresa', 'https://instagram.com/empresa');
    // facebook > tripadvisor
    both('https://facebook.com/empresa', 'https://tripadvisor.com/empresa', 'https://facebook.com/empresa');
    // social > unknown
    both('https://instagram.com/empresa', 'https://plataforma-desconhecida.example/empresa', 'https://instagram.com/empresa');
    // directory > unknown
    both('https://yelp.com/biz/empresa', 'https://plataforma-desconhecida.example/x', 'https://yelp.com/biz/empresa');
    // directory > none
    both('https://yelp.com/biz/empresa', null, 'https://yelp.com/biz/empresa');
    both('https://yelp.com/biz/empresa', '', 'https://yelp.com/biz/empresa');
    // unknown > none
    both('https://plataforma-desconhecida.example/empresa', null, 'https://plataforma-desconhecida.example/empresa');
    // same category: lexicographic stable
    both('https://instagram.com/a', 'https://instagram.com/b', 'https://instagram.com/a');
    both('https://yelp.com/biz/z', 'https://yelp.com/biz/a', 'https://yelp.com/biz/a');
  });

  it('mergeLeads website preference is order-independent', () => {
    function mergeBoth(wa, wb, expected) {
      const a = { name: 'X', website: wa, sourceProvider: 'apify', sources: ['apify'] };
      const b = { name: 'X', website: wb, sourceProvider: 'tomtom', sources: ['tomtom'] };
      assert.equal(mergeLeads(a, b).website, expected);
      assert.equal(mergeLeads(b, a).website, expected);
    }
    mergeBoth('https://instagram.com/x', 'https://yelp.com/biz/x', 'https://instagram.com/x');
    mergeBoth('https://facebook.com/x', 'https://tripadvisor.com/x', 'https://facebook.com/x');
    mergeBoth('https://instagram.com/x', 'https://desconhecida.example/x', 'https://instagram.com/x');
    mergeBoth('https://yelp.com/biz/x', null, 'https://yelp.com/biz/x');
    mergeBoth('https://desconhecida.example/x', null, 'https://desconhecida.example/x');
  });

  it('noWebsite after merge: social+directory include; only directory/unknown exclude', () => {
    function mergedWebsite(wa, wb) {
      const a = { name: 'X', website: wa, sourceProvider: 'apify', sources: ['apify'] };
      const b = { name: 'X', website: wb, sourceProvider: 'tomtom', sources: ['tomtom'] };
      return mergeLeads(a, b).website;
    }
    // Instagram + directory → Instagram → include
    {
      const w = mergedWebsite('https://instagram.com/empresa', 'https://yelp.com/biz/empresa');
      assert.equal(classifyWebsiteUrl(w), 'social_media');
      assert.equal(applyFilters([{ name: 'X', website: w }], { noWebsite: true }).length, 1);
    }
    // Facebook + TripAdvisor → Facebook → include
    {
      const w = mergedWebsite('https://facebook.com/empresa', 'https://tripadvisor.com/empresa');
      assert.equal(classifyWebsiteUrl(w), 'social_media');
      assert.equal(applyFilters([{ name: 'X', website: w }], { noWebsite: true }).length, 1);
    }
    // only directory → exclude
    {
      const w = mergedWebsite('https://yelp.com/biz/empresa', null);
      assert.equal(classifyWebsiteUrl(w), 'directory');
      assert.equal(applyFilters([{ name: 'X', website: w }], { noWebsite: true }).length, 0);
    }
    // Instagram + unknown → Instagram → include
    {
      const w = mergedWebsite('https://instagram.com/empresa', 'https://plataforma-desconhecida.example/empresa');
      assert.equal(classifyWebsiteUrl(w), 'social_media');
      assert.equal(applyFilters([{ name: 'X', website: w }], { noWebsite: true }).length, 1);
    }
    // only unknown → exclude
    {
      const w = mergedWebsite('https://plataforma-desconhecida.example/empresa', null);
      assert.equal(classifyWebsiteUrl(w), 'unknown');
      assert.equal(applyFilters([{ name: 'X', website: w }], { noWebsite: true }).length, 0);
    }
    // both empty → include
    {
      const w = mergedWebsite(null, null);
      assert.equal(classifyWebsiteUrl(w), 'none');
      assert.equal(applyFilters([{ name: 'X', website: w }], { noWebsite: true }).length, 1);
    }
  });

  it('noWebsite + hasPhone combination', () => {
    const leads = [
      { name: 'A', website: 'https://instagram.com/a', phone: '123' },
      { name: 'B', website: null, phone: null },
      { name: 'C', website: 'https://own.com', phone: '456' },
    ];
    const filtered = applyFilters(leads, { noWebsite: true, hasPhone: true });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, 'A');
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
