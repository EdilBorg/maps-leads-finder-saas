const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildMapsUrl, isSafeGoogleMapsUrl, publicLead } = require('../src/services/searchEngine');

describe('Google Maps URL helpers', () => {
  it('accepts only https Google Maps hosts', () => {
    assert.equal(isSafeGoogleMapsUrl('https://www.google.com/maps/place/x'), true);
    assert.equal(isSafeGoogleMapsUrl('https://maps.google.com/?q=1,2'), true);
    assert.equal(isSafeGoogleMapsUrl('http://www.google.com/maps'), false);
    assert.equal(isSafeGoogleMapsUrl('https://evil.example/maps'), false);
    assert.equal(isSafeGoogleMapsUrl('javascript:alert(1)'), false);
  });

  it('prefers safe provider maps URL', () => {
    const url = buildMapsUrl({
      mapsUrl: 'https://www.google.com/maps/place/Test',
      lat: 1,
      lng: 2,
      name: 'X',
    });
    assert.equal(url, 'https://www.google.com/maps/place/Test');
  });

  it('falls back to coordinates', () => {
    const url = buildMapsUrl({ name: 'A', lat: 38.7, lng: -9.1 });
    assert.match(url, /google\.com\/maps\/search/);
    assert.match(url, /38\.7/);
    assert.match(url, /-9\.1/);
  });

  it('falls back to name and address query', () => {
    const url = buildMapsUrl({ name: 'Barbearia', address: 'Lisboa' });
    assert.match(url, /query=Barbearia/);
    assert.match(url, /Lisboa/);
  });

  it('returns null without usable data', () => {
    assert.equal(buildMapsUrl({}), null);
  });

  it('publicLead exposes mapsUrl', () => {
    const p = publicLead({
      name: 'Shop',
      address: 'Rua 1',
      lat: 10,
      lng: 20,
      photoUrl: null,
      sourceProvider: 'apify',
    });
    assert.ok(p.mapsUrl);
    assert.match(p.mapsUrl, /google\.com\/maps/);
  });
});
