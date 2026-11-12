/**
 * OSM commercial/place search: Nominatim geocode + Overpass POI query.
 * Supports structured category tags (amenity/shop/…) and free-text name match.
 */
const { withTimeout, okResult, errorResult, DEFAULT_TIMEOUT_MS } = require('./baseProvider');
const CODE = 'osm';

/**
 * Extensible category catalogue: explicit aliases → OSM key/value tags.
 * Matching is exact after normalisation (no vague substring heuristics).
 */
const CATEGORIES = [
  {
    id: 'restaurants',
    tags: [
      { key: 'amenity', value: 'restaurant' },
      { key: 'amenity', value: 'fast_food' },
      { key: 'amenity', value: 'cafe' },
    ],
    aliases: [
      'restaurante',
      'restaurantes',
      'restaurant',
      'restaurants',
      'fast food',
      'fastfood',
      'cafe',
      'cafes',
      'café',
      'cafés',
    ],
  },
  {
    id: 'clinics',
    tags: [
      { key: 'amenity', value: 'clinic' },
      { key: 'healthcare', value: 'clinic' },
    ],
    aliases: [
      'clinica',
      'clinicas',
      'clínica',
      'clínicas',
      'clinic',
      'clinics',
    ],
  },
  {
    id: 'dentists',
    tags: [{ key: 'amenity', value: 'dentist' }],
    aliases: [
      'clinica dentaria',
      'clinicas dentarias',
      'clínica dentária',
      'clínicas dentárias',
      'clinica dentária',
      'clínica dentaria',
      'dentista',
      'dentistas',
      'dentist',
      'dentists',
    ],
  },
  {
    id: 'beauty',
    tags: [
      { key: 'shop', value: 'beauty' },
      { key: 'shop', value: 'hairdresser' },
    ],
    aliases: [
      'salao de beleza',
      'saloes de beleza',
      'salão de beleza',
      'salões de beleza',
      'salao de belesa',
      'cabeleireiro',
      'cabeleireiros',
      'cabeleireira',
      'cabeleireiras',
      'beauty',
      'beauty salon',
      'hairdresser',
      'hairdressers',
    ],
  },
  {
    id: 'shops',
    // Generic shop=* — kept intentional; radius + result limit bound cost.
    tags: [{ key: 'shop', value: null }],
    aliases: ['loja', 'lojas', 'shop', 'shops', 'store', 'stores'],
  },
];

function isConfigured() {
  return process.env.OSM_DISABLED !== '1';
}

function userAgent() {
  return process.env.OSM_USER_AGENT || 'MapsLeadsFinderSaaS/0.1 (contact@example.com)';
}

/** Lowercase, strip diacritics, collapse whitespace. */
function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeOverpassRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve query to a category via exact normalized alias match only.
 * @returns {{ id: string, tags: Array<{key:string,value:string|null}> }|null}
 */
function resolveCategory(query) {
  const normalized = normalizeText(query);
  if (!normalized) return null;
  for (const cat of CATEGORIES) {
    for (const alias of cat.aliases) {
      if (normalizeText(alias) === normalized) return cat;
    }
  }
  return null;
}

async function geocodeLocation(location) {
  const base = process.env.OSM_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
  const url = `${base}/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
  try {
    const data = await withTimeout(
      fetch(url, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
      }).then(async (res) => {
        if (!res.ok) {
          const err = new Error(`geocode HTTP ${res.status}`);
          err.code = 'HTTP_ERROR';
          err.errorStage = 'geocode';
          err.httpStatus = res.status;
          throw err;
        }
        return res.json();
      }),
      15000,
      'osm-geocode'
    );
    if (!Array.isArray(data) || !data[0]) return null;
    return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
  } catch (err) {
    if (err && !err.errorStage) err.errorStage = 'geocode';
    throw err;
  }
}

function groupTagsByKey(tags) {
  const byKey = new Map();
  for (const tag of tags) {
    if (!byKey.has(tag.key)) byKey.set(tag.key, []);
    byKey.get(tag.key).push(tag.value);
  }
  return byKey;
}

/**
 * Build Overpass union for structured category tags (no name filter).
 * Supports multiple keys, multi-value regex, and key-only (e.g. shop=*).
 */
function buildCategoryOverpassQuery(tags, radius, lat, lon, limit) {
  const lines = [];
  const byKey = groupTagsByKey(tags);

  for (const [key, values] of byKey.entries()) {
    const anyValue = values.some((v) => v == null);
    let filter;
    if (anyValue) {
      filter = `["${key}"]`;
    } else if (values.length === 1) {
      filter = `["${key}"=\"${values[0]}\"]`;
    } else {
      const reg = values.map((v) => escapeOverpassRegex(v)).join('|');
      filter = `["${key}"~"^(${reg})$"]`;
    }
    for (const type of ['node', 'way', 'relation']) {
      lines.push(`  ${type}${filter}(around:${radius},${lat},${lon});`);
    }
  }

  return `
[out:json][timeout:25];
(
${lines.join('\n')}
);
out center ${Math.min(limit, 100)};
`.trim();
}

/** Legacy free-text name search (preserves previous behaviour). */
function buildNameOverpassQuery(qEscaped, radius, lat, lon, limit) {
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

/**
 * Build Overpass QL for a user query.
 * Category aliases → tag filters; otherwise escaped name regex.
 * @param {string} query Raw user query (not pre-escaped).
 */
function buildOverpassQuery(query, radius, lat, lon, limit) {
  const category = resolveCategory(query);
  if (category) {
    return buildCategoryOverpassQuery(category.tags, radius, lat, lon, limit);
  }
  const qEscaped = escapeOverpassRegex(String(query == null ? '' : query));
  return buildNameOverpassQuery(qEscaped, radius, lat, lon, limit);
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
    tags['addr:city'],
    tags['addr:postcode'],
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
    category: tags.amenity || tags.shop || tags.office || tags.tourism || tags.healthcare || criteria.query,
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
    const overpassUrl = process.env.OSM_OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
    const ql = buildOverpassQuery(criteria.query, radius, center.lat, center.lon, limit);
    let data;
    try {
      data = await withTimeout(
        fetch(overpassUrl, {
          method: 'POST',
          headers: { 'User-Agent': userAgent(), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(ql)}`,
        }).then(async (res) => {
          if (!res.ok) {
            const err = new Error(`overpass HTTP ${res.status}`);
            err.code = 'HTTP_ERROR';
            err.errorStage = 'overpass';
            err.httpStatus = res.status;
            throw err;
          }
          return res.json();
        }),
        DEFAULT_TIMEOUT_MS,
        'osm-overpass'
      );
    } catch (err) {
      if (err && !err.errorStage) err.errorStage = 'overpass';
      throw err;
    }
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const mapped = elements.map((el) => mapElement(el, criteria)).filter(Boolean).slice(0, limit);
    return okResult(mapped);
  } catch (err) {
    const stage = (err && err.errorStage) || 'osm_search';
    const httpStatus = err && err.httpStatus != null ? err.httpStatus : null;
    const code = (err && err.code) || 'PROVIDER_ERROR';
    // Keep message short and free of credentials/URLs.
    let message = (err && err.message) || 'osm failed';
    message = String(message).slice(0, 200);
    return {
      status: 'error',
      results: [],
      errorCode: code,
      errorMessage: message,
      errorStage: stage,
      httpStatus,
    };
  }
}

module.exports = {
  code: CODE,
  isConfigured,
  search,
  escapeOverpassRegex,
  buildOverpassQuery,
  mapElement,
  normalizeText,
  resolveCategory,
  CATEGORIES,
};
