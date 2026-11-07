const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'google_maps';

function isConfigured() {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY.length > 8);
}

async function search(criteria) {
  if (!isConfigured()) {
    return notConfigured(CODE);
  }

  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    const text = encodeURIComponent(`${criteria.query} ${criteria.location || ''}`.trim());
    const url =
      `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${text}&key=${key}`;

    const data = await withTimeout(
      fetch(url).then(async (res) => {
        if (!res.ok) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'HTTP_ERROR' });
        }
        return res.json();
      }),
      DEFAULT_TIMEOUT_MS,
      CODE
    );

    if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return errorResult(data.status, data.error_message || data.status);
    }

    const places = Array.isArray(data.results) ? data.results : [];
    const limit = criteria.limit || 100;
    const mapped = places.slice(0, limit).map((p) => ({
      name: p.name || null,
      address: p.formatted_address || null,
      phone: null,
      email: null,
      website: null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviewsCount: typeof p.user_ratings_total === 'number' ? p.user_ratings_total : null,
      category: Array.isArray(p.types) && p.types[0] ? p.types[0] : criteria.query,
      lat: p.geometry && p.geometry.location ? p.geometry.location.lat : null,
      lng: p.geometry && p.geometry.location ? p.geometry.location.lng : null,
      sourceProvider: CODE,
      externalId: p.place_id || null,
      raw: { place_id: p.place_id, types: p.types },
    }));

    return okResult(mapped);
  } catch (err) {
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'google maps failed');
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
};
