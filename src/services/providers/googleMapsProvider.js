const {
  withTimeout,
  notConfigured,
  okResult,
  errorResult,
  DEFAULT_TIMEOUT_MS,
} = require('./baseProvider');

const CODE = 'google_maps';
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const MAX_PAGE_SIZE = 20;

/** Explicit FieldMask — never use wildcard in production. */
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.rating',
  'places.userRatingCount',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'nextPageToken',
].join(',');

function isConfigured() {
  return Boolean(process.env.GOOGLE_MAPS_API_KEY && process.env.GOOGLE_MAPS_API_KEY.length > 8);
}

function sanitizeMessage(msg) {
  if (msg == null) return 'google maps failed';
  let s = String(msg);
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (key && key.length > 4) {
    s = s.split(key).join('[redacted]');
  }
  return s.slice(0, 300);
}

function mapPlace(place, fallbackCategory) {
  if (!place || typeof place !== 'object') return null;

  const name =
    place.displayName && typeof place.displayName.text === 'string'
      ? place.displayName.text.trim() || null
      : null;
  const address =
    typeof place.formattedAddress === 'string' ? place.formattedAddress.trim() || null : null;

  let phone = null;
  if (typeof place.internationalPhoneNumber === 'string' && place.internationalPhoneNumber.trim()) {
    phone = place.internationalPhoneNumber.trim();
  } else if (typeof place.nationalPhoneNumber === 'string' && place.nationalPhoneNumber.trim()) {
    phone = place.nationalPhoneNumber.trim();
  }

  const website =
    typeof place.websiteUri === 'string' && place.websiteUri.trim()
      ? place.websiteUri.trim()
      : null;

  const rating = typeof place.rating === 'number' && Number.isFinite(place.rating) ? place.rating : null;
  const reviewsCount =
    typeof place.userRatingCount === 'number' && Number.isFinite(place.userRatingCount)
      ? place.userRatingCount
      : null;

  let category = null;
  if (typeof place.primaryType === 'string' && place.primaryType.trim()) {
    category = place.primaryType.trim();
  } else if (Array.isArray(place.types) && place.types[0]) {
    category = String(place.types[0]);
  } else if (fallbackCategory) {
    category = String(fallbackCategory);
  }

  const lat =
    place.location && place.location.latitude != null && Number.isFinite(Number(place.location.latitude))
      ? Number(place.location.latitude)
      : null;
  const lng =
    place.location && place.location.longitude != null && Number.isFinite(Number(place.location.longitude))
      ? Number(place.location.longitude)
      : null;

  const externalId = place.id != null ? String(place.id) : null;

  return {
    name,
    address,
    phone,
    email: null,
    website,
    rating,
    reviewsCount,
    category,
    lat,
    lng,
    sourceProvider: CODE,
    externalId,
    raw: {
      id: externalId,
      primaryType: place.primaryType || null,
      types: Array.isArray(place.types) ? place.types.slice(0, 8) : [],
    },
  };
}

/**
 * Single Text Search request. Does not put the API key in the URL.
 */
async function fetchSearchPage({ textQuery, pageSize, pageToken }) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const body = {
    textQuery,
    pageSize,
  };
  if (pageToken) body.pageToken = pageToken;

  const res = await withTimeout(
    fetch(SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    }),
    DEFAULT_TIMEOUT_MS,
    CODE
  );

  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error('Invalid JSON from Places API');
    err.code = 'INVALID_JSON';
    err.httpStatus = res.status;
    throw err;
  }

  if (!res.ok) {
    const apiMessage =
      (data && data.error && data.error.message) ||
      (data && data.message) ||
      `HTTP ${res.status}`;
    const err = new Error(sanitizeMessage(apiMessage));
    err.code =
      res.status === 401 || res.status === 403
        ? 'AUTH_ERROR'
        : res.status === 429
          ? 'QUOTA_ERROR'
          : res.status >= 500
            ? 'HTTP_ERROR'
            : 'HTTP_ERROR';
    err.httpStatus = res.status;
    throw err;
  }

  return data && typeof data === 'object' ? data : {};
}

async function search(criteria) {
  if (!isConfigured()) {
    return notConfigured(CODE);
  }

  const limit = Math.min(Math.max(parseInt(criteria.limit, 10) || 100, 1), 500);
  const textQuery = `${String(criteria.query || '').trim()} ${String(criteria.location || '').trim()}`.trim();
  if (!textQuery) {
    return errorResult('VALIDATION', 'query and location required');
  }

  const accumulated = [];
  const seenIds = new Set();
  let pageToken = null;
  let pageIndex = 0;
  // Safety bound: Places pages are ≤20; 500 results ⇒ ≤25 pages.
  const maxPages = 25;

  try {
    while (accumulated.length < limit && pageIndex < maxPages) {
      const pageSize = Math.min(MAX_PAGE_SIZE, limit - accumulated.length);
      if (pageSize <= 0) break;

      let data;
      try {
        data = await fetchSearchPage({
          textQuery,
          pageSize,
          pageToken: pageToken || undefined,
        });
      } catch (err) {
        // First page failure → total error for this provider.
        if (pageIndex === 0) {
          return errorResult(err.code || 'PROVIDER_ERROR', sanitizeMessage(err.message));
        }
        // Later page failure → keep accumulated results with error status.
        return {
          status: 'error',
          results: accumulated,
          errorCode: err.code || 'PROVIDER_ERROR',
          errorMessage: sanitizeMessage(err.message || 'pagination failed'),
        };
      }

      const places = Array.isArray(data.places) ? data.places : [];
      if (places.length === 0 && pageIndex === 0) {
        // Successful response with no places.
        return okResult([]);
      }

      for (const place of places) {
        if (accumulated.length >= limit) break;
        const mapped = mapPlace(place, criteria.query);
        if (!mapped) continue;
        const dedupeKey = mapped.externalId || `row:${accumulated.length}`;
        if (seenIds.has(dedupeKey)) continue;
        seenIds.add(dedupeKey);
        accumulated.push(mapped);
      }

      pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : null;
      pageIndex += 1;
      if (!pageToken) break;
    }

    return okResult(accumulated.slice(0, limit));
  } catch (err) {
    if (accumulated.length > 0) {
      return {
        status: 'error',
        results: accumulated.slice(0, limit),
        errorCode: err.code || 'PROVIDER_ERROR',
        errorMessage: sanitizeMessage(err.message),
      };
    }
    return errorResult(err.code || 'PROVIDER_ERROR', sanitizeMessage(err.message));
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  // Exported for unit tests only
  FIELD_MASK,
  SEARCH_URL,
  MAX_PAGE_SIZE,
  mapPlace,
};
