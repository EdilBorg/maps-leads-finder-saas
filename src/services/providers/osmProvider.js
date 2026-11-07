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
    const base = process.env.OSM_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
    const q = encodeURIComponent(`${criteria.query} ${criteria.location || ''}`.trim());
    const limit = Math.min(criteria.limit || 50, 50);
    const url = `${base}/search?q=${q}&format=json&addressdetails=1&limit=${limit}`;

    const data = await withTimeout(
      fetch(url, {
        headers: {
          'User-Agent': process.env.OSM_USER_AGENT || 'MapsLeadsFinderSaaS/0.1 (contact@example.com)',
          Accept: 'application/json',
        },
      }).then(async (res) => {
        if (!res.ok) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'HTTP_ERROR' });
        }
        return res.json();
      }),
      DEFAULT_TIMEOUT_MS,
      CODE
    );

    const list = Array.isArray(data) ? data : [];
    const mapped = list.map((p) => ({
      name: p.display_name ? String(p.display_name).split(',')[0].trim() : null,
      address: p.display_name || null,
      phone: null,
      email: null,
      website: null,
      rating: null,
      reviewsCount: null,
      category: p.type || p.class || criteria.query,
      lat: p.lat != null ? Number(p.lat) : null,
      lng: p.lon != null ? Number(p.lon) : null,
      sourceProvider: CODE,
      externalId: p.place_id != null ? String(p.place_id) : null,
      raw: { osm_id: p.osm_id, osm_type: p.osm_type },
    }));

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
