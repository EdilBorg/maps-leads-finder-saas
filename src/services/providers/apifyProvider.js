const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'apify';

function isConfigured() {
  return Boolean(process.env.APIFY_TOKEN && process.env.APIFY_TOKEN.length > 8);
}

async function search(criteria) {
  if (!isConfigured()) {
    return notConfigured(CODE);
  }

  try {
    const actorId = process.env.APIFY_ACTOR_ID;
    if (!actorId) {
      return notConfigured(CODE);
    }

    const token = process.env.APIFY_TOKEN;
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

    const body = {
      search: criteria.query,
      location: criteria.location,
      maxItems: criteria.limit || 100,
    };

    const data = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), {
            code: 'HTTP_ERROR',
          });
        }
        return res.json();
      }),
      Math.max(DEFAULT_TIMEOUT_MS, 60000),
      CODE
    );

    const list = Array.isArray(data) ? data : [];
    const mapped = list.map((p, idx) => ({
      name: p.name || p.title || null,
      address: p.address || p.fullAddress || null,
      phone: p.phone || p.phoneNumber || null,
      email: p.email || null,
      website: p.website || p.url || null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviewsCount: typeof p.reviewsCount === 'number' ? p.reviewsCount : null,
      category: p.category || criteria.query,
      lat: p.lat != null ? Number(p.lat) : p.latitude != null ? Number(p.latitude) : null,
      lng: p.lng != null ? Number(p.lng) : p.longitude != null ? Number(p.longitude) : null,
      sourceProvider: CODE,
      externalId: p.id != null ? String(p.id) : p.placeId != null ? String(p.placeId) : `apify-${idx}`,
      raw: {},
    }));

    return okResult(mapped);
  } catch (err) {
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'apify failed');
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
};
