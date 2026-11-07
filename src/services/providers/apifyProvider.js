/**
 * Apify adapter.
 * APIFY_INPUT_JSON supports {{query}}, {{location}}, {{limit}}
 * or APIFY_INPUT_QUERY_KEY / LOCATION_KEY / LIMIT_KEY
 */
const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'apify';

function isConfigured() {
  return Boolean(
    process.env.APIFY_TOKEN &&
      process.env.APIFY_TOKEN.length > 8 &&
      process.env.APIFY_ACTOR_ID
  );
}

function buildActorInput(criteria) {
  if (process.env.APIFY_INPUT_JSON) {
    const raw = process.env.APIFY_INPUT_JSON
      .replace(/\{\{query\}\}/g, criteria.query)
      .replace(/\{\{location\}\}/g, criteria.location || '')
      .replace(/\{\{limit\}\}/g, String(criteria.limit || 100));
    return JSON.parse(raw);
  }
  const qKey = process.env.APIFY_INPUT_QUERY_KEY || 'search';
  const lKey = process.env.APIFY_INPUT_LOCATION_KEY || 'location';
  const mKey = process.env.APIFY_INPUT_LIMIT_KEY || 'maxItems';
  return {
    [qKey]: criteria.query,
    [lKey]: criteria.location,
    [mKey]: criteria.limit || 100,
  };
}

function mapItem(p, idx, criteria) {
  return {
    name: p.name || p.title || p.businessName || null,
    address: p.address || p.fullAddress || p.street || null,
    phone: p.phone || p.phoneNumber || p.telephone || null,
    email: p.email || null,
    website: p.website || p.url || p.web || null,
    rating: typeof p.rating === 'number' ? p.rating : typeof p.stars === 'number' ? p.stars : null,
    reviewsCount:
      typeof p.reviewsCount === 'number'
        ? p.reviewsCount
        : typeof p.reviews === 'number'
          ? p.reviews
          : null,
    category: p.category || p.categoryName || criteria.query,
    lat: p.lat != null ? Number(p.lat) : p.latitude != null ? Number(p.latitude) : null,
    lng: p.lng != null ? Number(p.lng) : p.longitude != null ? Number(p.longitude) : null,
    sourceProvider: CODE,
    externalId:
      p.id != null
        ? String(p.id)
        : p.placeId != null
          ? String(p.placeId)
          : p.place_id != null
            ? String(p.place_id)
            : `apify-${idx}`,
    raw: {},
  };
}

async function search(criteria) {
  if (!isConfigured()) {
    return notConfigured(CODE);
  }
  try {
    const actorId = process.env.APIFY_ACTOR_ID;
    const token = process.env.APIFY_TOKEN;
    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    let body;
    try {
      body = buildActorInput(criteria);
    } catch (e) {
      return errorResult('APIFY_INPUT_INVALID', e.message || 'invalid APIFY_INPUT_JSON');
    }
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
      Math.max(DEFAULT_TIMEOUT_MS, 90000),
      CODE
    );
    const list = Array.isArray(data) ? data : [];
    return okResult(list.map((p, idx) => mapItem(p, idx, criteria)));
  } catch (err) {
    return errorResult(err.code || 'PROVIDER_ERROR', err.message || 'apify failed');
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  buildActorInput,
};
