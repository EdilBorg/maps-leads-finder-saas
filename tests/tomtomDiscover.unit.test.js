/**
 * TomTom Discover v3 normalizer — official response schema fixtures.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const tomtom = require('../src/services/providers/tomtomProvider');

const OFFICIAL_ITEM = {
  id: 'i4gXDo36dRMSvuujipsMMA',
  title: 'Nautilus Hotel & Restaurant',
  type: 'poi',
  poiTypes: [
    { id: 'hotel', name: 'Hotel', groupId: 'lodging', role: 'preferred', parentId: 'hotel_or_motel' },
  ],
  position: { type: 'Point', coordinates: [13.463133, 54.327423] },
  subtitles: ['Neukamp 17', '18581 Putbus', 'Germany'],
  distanceInMeters: 7557,
  address: {
    country: 'Germany',
    countryCodeIso2: 'DE',
    municipality: 'Putbus',
    postalCode: '18581',
    street: 'Neukamp',
    houseNumber: '17',
  },
  contacts: [
    {
      type: 'default',
      phones: ['+49 38301 830'],
      websites: ['http://www.ruegen-nautilus.de'],
    },
  ],
};

describe('tomtom Discover v3 mapDiscoverItem', () => {
  it('maps full official payload', () => {
    const lead = tomtom.mapDiscoverItem(OFFICIAL_ITEM, 0, { query: 'hotel' });
    assert.ok(lead);
    assert.equal(lead.name, 'Nautilus Hotel & Restaurant');
    assert.equal(lead.phone, '+49 38301 830');
    assert.equal(lead.website, 'http://www.ruegen-nautilus.de');
    assert.equal(lead.lat, 54.327423);
    assert.equal(lead.lng, 13.463133);
    assert.equal(lead.category, 'Hotel');
    assert.equal(lead.externalId, 'i4gXDo36dRMSvuujipsMMA');
    assert.ok(lead.address && lead.address.includes('Neukamp'));
    assert.equal(lead.sourceProvider, 'tomtom');
  });

  it('handles missing phone and website', () => {
    const item = {
      id: 'x1',
      title: 'Cafe Alone',
      position: { coordinates: [10, 50], type: 'Point' },
      address: { street: 'Main', houseNumber: '1', municipality: 'Town' },
      contacts: [{ type: 'default' }],
      poiTypes: [{ name: 'Cafe' }],
    };
    const lead = tomtom.mapDiscoverItem(item, 0, { query: 'cafe' });
    assert.equal(lead.name, 'Cafe Alone');
    assert.equal(lead.phone, null);
    assert.equal(lead.website, null);
    assert.equal(lead.lat, 50);
    assert.equal(lead.lng, 10);
  });

  it('handles missing address via subtitles', () => {
    const item = {
      id: 'x2',
      title: 'Place',
      subtitles: ['Line1', 'Line2'],
      position: { coordinates: [1, 2], type: 'Point' },
    };
    const lead = tomtom.mapDiscoverItem(item, 0, { query: 'q' });
    assert.equal(lead.address, 'Line1, Line2');
  });

  it('handles missing coordinates', () => {
    const item = { id: 'x3', title: 'NoCoords', contacts: [{ phones: ['123'] }] };
    const lead = tomtom.mapDiscoverItem(item, 0, { query: 'q' });
    assert.equal(lead.lat, null);
    assert.equal(lead.lng, null);
    assert.equal(lead.phone, '123');
  });

  it('returns null without title/name', () => {
    assert.equal(tomtom.mapDiscoverItem({ id: 'x' }, 0, {}), null);
  });

  it('picks first of multiple contacts', () => {
    const item = {
      id: 'x4',
      title: 'Multi',
      contacts: [
        { type: 'reservations', phones: ['111'], websites: ['https://a.example'] },
        { type: 'default', phones: ['222'], websites: ['https://b.example'] },
      ],
      position: { coordinates: [0, 0], type: 'Point' },
    };
    const lead = tomtom.mapDiscoverItem(item, 0, { query: 'q' });
    assert.equal(lead.phone, '111');
    assert.equal(lead.website, 'https://a.example');
  });

  it('buildDiscoverBody caps maxResults at 100', () => {
    const body = tomtom.buildDiscoverBody({
      query: 'cafe',
      location: 'Maputo',
      lat: -25.9,
      lng: 32.5,
      maxResults: 500,
    });
    assert.ok(body.maxResults <= 100);
    assert.equal(body.maxResults, 100);
  });

  it('buildDiscoverBody uses [lon, lat] for origin', () => {
    const body = tomtom.buildDiscoverBody({
      query: 'cafe',
      lat: -25.9,
      lng: 32.5,
      maxResults: 10,
    });
    assert.deepEqual(body.origin.coordinates, [32.5, -25.9]);
  });
});
