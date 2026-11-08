/**
 * OSM commercial/place search: Nominatim geocode + Overpass POI query.
 * Covers node, way and relation for amenity/shop/office/tourism + name match.
 */
const { withTimeout, okResult, errorResult, DEFAULT_TIMEOUT_MS } = require('./baseProvider');
const CODE = 'osm';

function isConfigured() {
  return process.env.OSM_DISABLED !== '1';
}

function userAgent() {
  return process.env.OSM_USER_AGENT || 'MapsLeadsFinderSaaS/0.1 (contact@example.com)';
}

function escapeOverpassRegex(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\[\](){}.+*?^$|]/g, '\\$&');
}

async function geocodeLocation(location) {
  const base = process.env.OSM_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
  const url = `${base}/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const data = await withTimeout(
    fetch(url, {
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
    }).then(async (res) => {
      if (!res.ok) throw Object.assign(new Error(`geocode HTTP ${res.status}`), { code: 'HTTP_ERROR' });
      return res.json();
    }),
    15000,
    'osm-geocode'
  );
  if (!Array.isArray(data) || !data[0]) return null;
  return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
}

function buildOverpassQuery(qEscaped, radius, lat, lon, limit) {
  return `
[out:json][timeout:25];
(
  node["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  way["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  node["amenity"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  way["amenity"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  node["shop"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  way["shop"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  node["office"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  way["office"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  node["tourism"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  way["tourism"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  relation["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  relation["amenity"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
  relation["shop"]["name"~"${qEscaped}",i](around:${radius},${lat},${lon});
);
out center ${Math.min(limit, 100)};
`.trim();
}

function mapElement(el, criteria) {
  const tags = el.tags || {};
  const name = tags.name || tags['name:pt'] || tags['name:en'] || null;
  if (!name) return null;
  const lat = el.lat != null ? Number(el.lat) : el.center ? Number(el.center.lat) : null;
  const lon = el.lon != null ? Number(el.lon) : el.center ? Number(el.center.lon) : null;
  const addressParts = [
    tags['addr:street'],
    tags['addr:housenumber'],
    tags['addr:city'] || tags['addr:town'],
    tags['addr:country'],
  ].filter(Boolean);
  return {
    name,
    address: addressParts.length ? addressParts.join(', ') : tags['addr:full'] || null,
    phone: tags.phone || tags['contact:phone'] || null,
    email: tags.email || tags['contact:email'] || null,
    website: tags.website || tags['contact:website'] || tags.url || null,
    rating: null,
    reviewsCount: null,
    category: tags.amenity || tags.shop || tags.office || tags.tourism || criteria.query,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lon) ? lon : null,
    sourceProvider: CODE,
    externalId: `${el.type || 'n'}/${el.id}`,
    raw: { osm_type: el.type, osm_id: el.id },
  };
}

async function search(criteria) {
  if (!isConfigured()) {
    return { status: 'not_configured', results: [], errorCode: 'NOT_CONFIGURED', errorMessage: 'OSM disabled' };
  }
  try {
    const center = await geocodeLocation(criteria.location);
    if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) return okResult([]);
    const radius = Math.min(Math.max(parseInt(process.env.OSM_SEARCH_RADIUS_M || '5000', 10) || 5000, 500), 25000);
    const limit = Math.min(criteria.limit || 50, 100);
    const qEscaped = escapeOverpassRegex(criteria.query);
    const overpassUrl = process.env.OSM_OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
    const ql = buildOverpassQuery(qEscaped, radius, center.lat, center.lon, limit);
    const data = await withTimeout(
      fetch(overpassUrl, {
        method: 'POST',
        headers: { 'User-Agent': userAgent(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(ql)}`,
      }).then(async (res) => {
        if (!res.ok) throw Object.assign(new Error(`overpass HTTP ${res.status}`), { code: 'HTTP_ERROR' });
        return res.json();
      }),
      Math.max(DEFAULT_TIMEOUT_MS, 35000),
      CODE
    );
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const mapped = [];
    const seen = new Set();
    for (const el of elements) {
      const item = mapElement(el, criteria);
      if (!item) continue;
      if (seen.has(item.externalId)) continue;
      seen.add(item.externalId);
      mapped.push(item);
      if (mapped.length >= limit) break;
    }
    return okResult(mapped);
  } catch (err) {
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'osm failed');
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  escapeOverpassRegex,
  buildOverpassQuery,
  mapElement,
};
