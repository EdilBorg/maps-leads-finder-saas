/**
 * OpenStreetMap commercial/place search via Overpass API.
 * Nominatim is only used as a geocoder for the location string.
 */
const {
  withTimeout,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'osm';

function isConfigured() {
  if (process.env.OSM_DISABLED === '1') return false;
  return true;
}

function userAgent() {
  return process.env.OSM_USER_AGENT || 'MapsLeadsFinderSaaS/0.1 (contact@example.com)';
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

function escapeOverpass(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function search(criteria) {
  if (!isConfigured()) {
    return {
      status: 'not_configured',
      results: [],
      errorCode: 'NOT_CONFIGURED',
      errorMessage: 'OSM disabled',
    };
  }

  try {
    const center = await geocodeLocation(criteria.location);
    if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
      return okResult([]);
    }

    const radius = Math.min(
      Math.max(parseInt(process.env.OSM_SEARCH_RADIUS_M || '5000', 10) || 5000, 500),
      25000
    );
    const limit = Math.min(criteria.limit || 50, 100);
    const q = escapeOverpass(criteria.query);
    const overpassUrl = process.env.OSM_OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

    const ql = `
[out:json][timeout:25];
(
  node["name"~"${q}",i](around:${radius},${center.lat},${center.lon});
  way["name"~"${q}",i](around:${radius},${center.lat},${center.lon});
  node["amenity"]["name"](around:${radius},${center.lat},${center.lon});
  node["shop"]["name"](around:${radius},${center.lat},${center.lon});
  node["office"]["name"](around:${radius},${center.lat},${center.lon});
  node["tourism"]["name"](around:${radius},${center.lat},${center.lon});
);
out center ${limit};
`.trim();

    const data = await withTimeout(
      fetch(overpassUrl, {
        method: 'POST',
        headers: {
          'User-Agent': userAgent(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(ql)}`,
      }).then(async (res) => {
        if (!res.ok) {
          throw Object.assign(new Error(`overpass HTTP ${res.status}`), { code: 'HTTP_ERROR' });
        }
        return res.json();
      }),
      Math.max(DEFAULT_TIMEOUT_MS, 35000),
      CODE
    );

    const elements = Array.isArray(data.elements) ? data.elements : [];
    const qNorm = criteria.query.toLowerCase();
    const mapped = [];
    const seen = new Set();

    for (const el of elements) {
      const tags = el.tags || {};
      const name = tags.name || tags['name:pt'] || tags['name:en'] || null;
      if (!name) continue;
      const nameLower = name.toLowerCase();
      const relevant =
        nameLower.includes(qNorm) ||
        (tags.amenity && String(tags.amenity).includes(qNorm)) ||
        (tags.shop && String(tags.shop).includes(qNorm)) ||
        qNorm.split(/\s+/).some((w) => w.length > 2 && nameLower.includes(w));
      if (!relevant && elements.length > limit) continue;

      const lat = el.lat != null ? Number(el.lat) : el.center ? Number(el.center.lat) : null;
      const lon = el.lon != null ? Number(el.lon) : el.center ? Number(el.center.lon) : null;
      const externalId = `${el.type || 'n'}/${el.id}`;
      if (seen.has(externalId)) continue;
      seen.add(externalId);

      const addressParts = [
        tags['addr:street'],
        tags['addr:housenumber'],
        tags['addr:city'] || tags['addr:town'],
        tags['addr:country'],
      ].filter(Boolean);

      mapped.push({
        name,
        address: addressParts.length ? addressParts.join(', ') : tags['addr:full'] || null,
        phone: tags.phone || tags['contact:phone'] || null,
        email: tags.email || tags['contact:email'] || null,
        website: tags.website || tags['contact:website'] || tags.url || null,
        rating: null,
        reviewsCount: null,
        category: tags.amenity || tags.shop || tags.office || tags.tourism || criteria.query,
        lat,
        lng: lon,
        sourceProvider: CODE,
        externalId,
        raw: { osm_type: el.type, osm_id: el.id },
      });
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
};
