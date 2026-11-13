/**
 * OSM commercial/place search: Nominatim geocode + Overpass POI query.
<<<<<<< HEAD
 * Supports structured category tags (amenity/shop/…) and free-text name match.
=======
 * Supports structured category tags (amenity/shop/…) combined with free-text name match.
 * Multi-endpoint Overpass fallback for transient failures.
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
 */
const { withTimeout, okResult, DEFAULT_TIMEOUT_MS } = require('./baseProvider');
const CODE = 'osm';

<<<<<<< HEAD
=======
const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const TRANSIENT_HTTP = new Set([429, 502, 503, 504]);
const TRANSIENT_NET = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ABORTED',
  'PROVIDER_TIMEOUT',
]);

/**
 * Category catalogue adapted from original osmTagClauses + existing SaaS coverage.
 * Exact alias match after normalisation (case, accents, whitespace).
 */
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
const CATEGORIES = [
  {
    id: 'restaurants',
    tags: [
      { key: 'amenity', value: 'restaurant' },
      { key: 'amenity', value: 'fast_food' },
      { key: 'amenity', value: 'cafe' },
    ],
    aliases: [
      'restaurante', 'restaurantes', 'restaurant', 'restaurants',
      'fast food', 'fastfood', 'cafe', 'cafes', 'café', 'cafés',
<<<<<<< HEAD
=======
      'cafeteria', 'cafeterias', 'pastelaria', 'pastelarias',
    ],
  },
  {
    id: 'pharmacies',
    tags: [{ key: 'amenity', value: 'pharmacy' }],
    aliases: [
      'farmacia', 'farmacias', 'farmácia', 'farmácias',
      'pharmacy', 'pharmacies',
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
    ],
  },
  {
    id: 'clinics',
    tags: [
      { key: 'amenity', value: 'clinic' },
<<<<<<< HEAD
      { key: 'healthcare', value: 'clinic' },
    ],
    aliases: ['clinica', 'clinicas', 'clínica', 'clínicas', 'clinic', 'clinics'],
=======
      { key: 'amenity', value: 'doctors' },
      { key: 'healthcare', value: 'clinic' },
    ],
    aliases: [
      'clinica', 'clinicas', 'clínica', 'clínicas',
      'clinic', 'clinics', 'medico', 'médico', 'medicos', 'médicos',
      'saude', 'saúde',
    ],
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
  },
  {
    id: 'dentists',
    tags: [{ key: 'amenity', value: 'dentist' }],
    aliases: [
      'clinica dentaria', 'clinicas dentarias', 'clínica dentária', 'clínicas dentárias',
<<<<<<< HEAD
      'clinica dentária', 'clínica dentaria', 'dentista', 'dentistas', 'dentist', 'dentists',
=======
      'clinica dentária', 'clínica dentaria', 'dentista', 'dentistas',
      'dentist', 'dentists', 'dental',
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
    ],
  },
  {
    id: 'beauty',
    tags: [
      { key: 'shop', value: 'beauty' },
      { key: 'shop', value: 'hairdresser' },
<<<<<<< HEAD
=======
      { key: 'craft', value: 'hairdresser' },
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
    ],
    aliases: [
      'salao de beleza', 'saloes de beleza', 'salão de beleza', 'salões de beleza',
      'salao de belesa', 'cabeleireiro', 'cabeleireiros', 'cabeleireira', 'cabeleireiras',
<<<<<<< HEAD
      'beauty', 'beauty salon', 'hairdresser', 'hairdressers',
=======
      'barbeiro', 'barbeiros', 'barbearia', 'barbearias',
      'beauty', 'beauty salon', 'hairdresser', 'hairdressers', 'hair',
    ],
  },
  {
    id: 'hotels',
    tags: [
      { key: 'tourism', value: 'hotel' },
      { key: 'tourism', value: 'hostel' },
      { key: 'tourism', value: 'guest_house' },
    ],
    aliases: [
      'hotel', 'hoteis', 'hotéis', 'hotels',
      'alojamento', 'alojamentos', 'hostel', 'hostels',
      'guest house', 'guesthouse',
    ],
  },
  {
    id: 'gyms',
    tags: [
      { key: 'leisure', value: 'fitness_centre' },
      { key: 'leisure', value: 'sports_centre' },
    ],
    aliases: [
      'ginasio', 'ginásio', 'ginasios', 'ginásios',
      'gym', 'gyms', 'fitness', 'fitness centre', 'fitness center',
    ],
  },
  {
    id: 'car_repair',
    tags: [
      { key: 'shop', value: 'car_repair' },
      { key: 'shop', value: 'car' },
    ],
    aliases: [
      'oficina', 'oficinas', 'mecanico', 'mecânico', 'mecanicos', 'mecânicos',
      'auto repair', 'carro', 'carros', 'car repair',
    ],
  },
  {
    id: 'lawyers',
    tags: [{ key: 'office', value: 'lawyer' }],
    aliases: [
      'advogado', 'advogados', 'advogada', 'advogadas',
      'juridico', 'jurídico', 'juridicos', 'jurídicos',
      'lawyer', 'lawyers',
    ],
  },
  {
    id: 'accountants',
    tags: [{ key: 'office', value: 'accountant' }],
    aliases: [
      'contabilista', 'contabilistas', 'contabil', 'contábil',
      'accountant', 'accountants',
    ],
  },
  {
    id: 'veterinary',
    tags: [{ key: 'amenity', value: 'veterinary' }],
    aliases: [
      'veterinario', 'veterinário', 'veterinarios', 'veterinários',
      'veterinaria', 'veterinária', 'veterinary',
    ],
  },
  {
    id: 'bakeries',
    tags: [{ key: 'shop', value: 'bakery' }],
    aliases: [
      'padaria', 'padarias', 'bakery', 'bakeries',
    ],
  },
  {
    id: 'supermarkets',
    tags: [
      { key: 'shop', value: 'supermarket' },
      { key: 'shop', value: 'convenience' },
    ],
    aliases: [
      'supermercado', 'supermercados', 'mercearia', 'mercearias',
      'supermarket', 'supermarkets', 'convenience',
    ],
  },
  {
    id: 'florists',
    tags: [{ key: 'shop', value: 'florist' }],
    aliases: [
      'florista', 'floristas', 'flor', 'flores', 'florist', 'florists',
    ],
  },
  {
    id: 'clothes',
    tags: [{ key: 'shop', value: 'clothes' }],
    aliases: [
      'roupa', 'roupas', 'boutique', 'boutiques', 'vestuario', 'vestuário',
      'clothes', 'clothing',
    ],
  },
  {
    id: 'electronics',
    tags: [
      { key: 'shop', value: 'electronics' },
      { key: 'shop', value: 'mobile_phone' },
    ],
    aliases: [
      'eletronicos', 'eletrónicos', 'eletronica', 'eletrónica',
      'telemovel', 'telemóvel', 'telemoveis', 'telemóveis',
      'phone', 'phones', 'electronics', 'mobile phone',
    ],
  },
  {
    id: 'schools',
    tags: [
      { key: 'amenity', value: 'school' },
      { key: 'amenity', value: 'college' },
    ],
    aliases: [
      'escola', 'escolas', 'academy', 'formacao', 'formação',
      'school', 'schools', 'college', 'colleges',
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
    ],
  },
  {
    id: 'shops',
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

function normalizeText(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
<<<<<<< HEAD
}

function escapeOverpassRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

/**
 * Extract a stable technical error code from Node fetch / undici failures.
 * Native fetch often wraps system errors as TypeError("fetch failed") with err.cause.
 */
function resolveErrorCode(err) {
  if (!err || typeof err !== 'object') return 'PROVIDER_ERROR';

  const asCode = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s.length > 64) return null;
    if (s === 'undefined' || s === 'null') return null;
    return s;
  };

  const direct = asCode(err.code);
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : null;
  const causeCode = cause ? asCode(cause.code) || asCode(cause.errno) : null;

  const outerIsGenericFetch =
    err.name === 'TypeError' ||
    (typeof err.message === 'string' && /fetch failed/i.test(err.message));

  if (outerIsGenericFetch && causeCode) return causeCode;
  if (direct && direct !== 'ERR_INVALID_THIS') return direct;
  if (causeCode) return causeCode;
  if (err.name === 'AbortError') return 'ABORTED';
  if (direct) return direct;
  return 'PROVIDER_ERROR';
}

function resolveCauseCode(err) {
  if (!err || typeof err !== 'object' || !err.cause || typeof err.cause !== 'object') return null;
  const c = err.cause;
  if (c.code != null) {
    const s = String(c.code).trim();
    return s ? s.slice(0, 64) : null;
  }
  if (c.errno != null) {
    const s = String(c.errno).trim();
    return s ? s.slice(0, 64) : null;
  }
  return null;
}

function resolveErrorName(err) {
  if (!err || typeof err !== 'object') return null;
  if (typeof err.name === 'string' && err.name && err.name !== 'Error') {
    return err.name.slice(0, 64);
  }
  return null;
}

function sanitizeOsmErrorMessage(err) {
  let message = (err && err.message) || 'osm failed';
  if (
    typeof message === 'string' &&
    /fetch failed/i.test(message) &&
    err &&
    err.cause &&
    typeof err.cause.message === 'string' &&
    err.cause.message
  ) {
    message = err.cause.message;
  }
  return String(message).slice(0, 200);
=======
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
}

function escapeOverpassRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

/**
 * Extract a stable technical error code from Node fetch / undici failures.
 * Native fetch often wraps system errors as TypeError("fetch failed") with err.cause.
 */
function resolveErrorCode(err) {
  if (!err || typeof err !== 'object') return 'PROVIDER_ERROR';

  const asCode = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s || s.length > 64) return null;
    if (s === 'undefined' || s === 'null') return null;
    return s;
  };

  const direct = asCode(err.code);
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : null;
  const causeCode = cause ? asCode(cause.code) || asCode(cause.errno) : null;

  const outerIsGenericFetch =
    err.name === 'TypeError' ||
    (typeof err.message === 'string' && /fetch failed/i.test(err.message));

  if (outerIsGenericFetch && causeCode) return causeCode;
  if (direct && direct !== 'ERR_INVALID_THIS') return direct;
  if (causeCode) return causeCode;
  if (err.name === 'AbortError') return 'ABORTED';
  if (direct) return direct;
  return 'PROVIDER_ERROR';
}

function resolveCauseCode(err) {
  if (!err || typeof err !== 'object' || !err.cause || typeof err.cause !== 'object') return null;
  const c = err.cause;
  if (c.code != null) {
    const s = String(c.code).trim();
    return s ? s.slice(0, 64) : null;
  }
  if (c.errno != null) {
    const s = String(c.errno).trim();
    return s ? s.slice(0, 64) : null;
  }
  return null;
}

function resolveErrorName(err) {
  if (!err || typeof err !== 'object') return null;
  if (typeof err.name === 'string' && err.name && err.name !== 'Error') {
    return err.name.slice(0, 64);
  }
  return null;
}

function sanitizeOsmErrorMessage(err) {
  let message = (err && err.message) || 'osm failed';
  if (
    typeof message === 'string' &&
    /fetch failed/i.test(message) &&
    err &&
    err.cause &&
    typeof err.cause.message === 'string' &&
    err.cause.message
  ) {
    message = err.cause.message;
  }
  return String(message).slice(0, 200);
}

function extractRemarkError(data) {
  if (!data || typeof data !== 'object') return null;
  const remark = data.remark != null ? String(data.remark).trim() : '';
  if (!remark) return null;
  const lower = remark.toLowerCase();
  if (/^(info|notice):/i.test(remark) && !/error|timeout|runtime|out of memory|killed/i.test(lower)) {
    return null;
  }
  if (
    /error|timeout|runtime error|out of memory|query timed out|killed|dispatcher|too many|rate.?limit|rejected/i.test(
      lower
    )
  ) {
    return remark.slice(0, 300);
  }
  if (/error|timeout|fail/i.test(lower)) {
    return remark.slice(0, 300);
  }
  return null;
}

function isTransientError(err) {
  if (!err) return false;
  const code = resolveErrorCode(err);
  if (TRANSIENT_NET.has(code)) return true;
  if (err.httpStatus != null && TRANSIENT_HTTP.has(Number(err.httpStatus))) return true;
  if (code === 'HTTP_ERROR' && err.httpStatus != null && TRANSIENT_HTTP.has(Number(err.httpStatus))) {
    return true;
  }
  if (code === 'OSM_REMARK' || code === 'OSM_INVALID_JSON' || code === 'OSM_INVALID_BODY') return true;
  return false;
}

/**
 * Geocode via Nominatim. Returns { lat, lon, bbox? } where bbox is
 * { south, north, west, east } when Nominatim provides a valid boundingbox.
 */
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
<<<<<<< HEAD
    return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
=======
    const item = data[0];
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const result = { lat, lon };
    const bb = item.boundingbox;
    if (Array.isArray(bb) && bb.length >= 4) {
      const south = parseFloat(bb[0]);
      const north = parseFloat(bb[1]);
      const west = parseFloat(bb[2]);
      const east = parseFloat(bb[3]);
      if (
        Number.isFinite(south) &&
        Number.isFinite(north) &&
        Number.isFinite(west) &&
        Number.isFinite(east) &&
        south < north &&
        west < east
      ) {
        result.bbox = { south, north, west, east };
      }
    }
    return result;
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
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

<<<<<<< HEAD
function buildCategoryOverpassQuery(tags, radius, lat, lon, limit) {
  const lines = [];
  const byKey = groupTagsByKey(tags);

=======
/**
 * Build area filter: prefer bbox when available, else around:radius.
 */
function areaFilter(geo, radius) {
  if (geo && geo.bbox) {
    const { south, west, north, east } = geo.bbox;
    return `(${south},${west},${north},${east})`;
  }
  return `(around:${radius},${geo.lat},${geo.lon})`;
}

function tagFilterLines(tags, area) {
  const lines = [];
  const byKey = groupTagsByKey(tags);
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
  for (const [key, values] of byKey.entries()) {
    const anyValue = values.some((v) => v == null);
    let filter;
    if (anyValue) {
      filter = '["' + key + '"]';
    } else if (values.length === 1) {
      filter = '["' + key + '"="' + values[0] + '"]';
    } else {
<<<<<<< HEAD
      const reg = values.map((v) => escapeOverpassRegex(v)).join('|');
      filter = '["' + key + '"~"^(' + reg + ')$"]';
    }
    for (const type of ['node', 'way', 'relation']) {
      lines.push('  ' + type + filter + '(around:' + radius + ',' + lat + ',' + lon + ');');
    }
  }
=======
      const reg = values.map((v) => escapeOverpassRegex(String(v))).join('|');
      filter = '["' + key + '"~"^(' + reg + ')$"]';
    }
    for (const type of ['node', 'way', 'relation']) {
      lines.push('  ' + type + filter + area + ';');
    }
  }
  return lines;
}

function nameFilterLines(qEscaped, area, withCommercialKeys) {
  const lines = [];
  // Broad name match
  for (const type of ['node', 'way', 'relation']) {
    lines.push('  ' + type + '["name"~"' + qEscaped + '",i]' + area + ';');
  }
  if (withCommercialKeys) {
    const keys = ['amenity', 'shop', 'craft', 'office', 'tourism'];
    for (const key of keys) {
      for (const type of ['node', 'way', 'relation']) {
        lines.push('  ' + type + '["' + key + '"]["name"~"' + qEscaped + '",i]' + area + ';');
      }
    }
  }
  return lines;
}

/**
 * Build Overpass QL.
 * - Recognised category: category tags + name match (combined).
 * - Unknown query: name match + commercial-key name filters (fallback).
 *
 * Signature kept compatible with existing tests:
 *   buildOverpassQuery(query, radius, lat, lon, limit [, geo])
 * When geo is provided and has bbox, bbox is used instead of around.
 */
function buildOverpassQuery(query, radius, lat, lon, limit, geo) {
  const areaGeo = geo && (geo.bbox || (Number.isFinite(geo.lat) && Number.isFinite(geo.lon)))
    ? geo
    : { lat, lon };
  const area = areaFilter(areaGeo, radius);
  const outLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const category = resolveCategory(query);
  const qEscaped = escapeOverpassRegex(String(query == null ? '' : query).trim());
  const lines = [];

  if (category) {
    // Category tags
    lines.push(...tagFilterLines(category.tags, area));
    // Always also search by name so specific establishments are not missed
    if (qEscaped) {
      lines.push(...nameFilterLines(qEscaped, area, false));
    }
  } else if (qEscaped) {
    // Free-text: name + commercial keys (original fallback behaviour)
    lines.push(...nameFilterLines(qEscaped, area, true));
  } else {
    // Empty query — return minimal valid query that yields nothing useful
    lines.push('  node(0);');
  }
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)

  return (
    '[out:json][timeout:25];\n(\n' +
    lines.join('\n') +
    '\n);\nout center ' +
<<<<<<< HEAD
    Math.min(limit, 100) +
    ';'
  ).trim();
}

function buildNameOverpassQuery(qEscaped, radius, lat, lon, limit) {
  const a = '(around:' + radius + ',' + lat + ',' + lon + ')';
  return (
    '[out:json][timeout:25];\n(\n' +
    '  node["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  way["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  node["amenity"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  way["amenity"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  node["shop"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  way["shop"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  node["office"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  way["office"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  node["tourism"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  way["tourism"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  relation["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  relation["amenity"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    '  relation["shop"]["name"~"' + qEscaped + '",i]' + a + ';\n' +
    ');\nout center ' +
    Math.min(limit, 100) +
    ';'
  ).trim();
}

function buildOverpassQuery(query, radius, lat, lon, limit) {
  const category = resolveCategory(query);
  if (category) {
    return buildCategoryOverpassQuery(category.tags, radius, lat, lon, limit);
  }
  const qEscaped = escapeOverpassRegex(String(query == null ? '' : query));
  return buildNameOverpassQuery(qEscaped, radius, lat, lon, limit);
=======
    outLimit +
    ';'
  ).trim();
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
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
<<<<<<< HEAD
    category: tags.amenity || tags.shop || tags.office || tags.tourism || tags.healthcare || criteria.query,
=======
    category: tags.amenity || tags.shop || tags.office || tags.tourism || tags.healthcare || tags.leisure || tags.craft || criteria.query,
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lon) ? lon : null,
    sourceProvider: CODE,
    externalId: `${el.type || 'n'}/${el.id}`,
    raw: { osm_type: el.type, osm_id: el.id },
  };
}

function resolveOverpassEndpoints() {
  const single = process.env.OSM_OVERPASS_URL;
  if (single && String(single).trim()) {
    return [String(single).trim()];
  }
  return DEFAULT_OVERPASS_ENDPOINTS.slice();
}

/**
 * Execute Overpass query against one endpoint with timeout and response validation.
 */
async function fetchOverpassOnce(endpoint, ql, timeoutMs) {
  const res = await withTimeout(
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'User-Agent': userAgent(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: `data=${encodeURIComponent(ql)}`,
    }),
    timeoutMs,
    'osm-overpass'
  );

  if (!res.ok) {
    const err = new Error(`overpass HTTP ${res.status}`);
    err.code = 'HTTP_ERROR';
    err.errorStage = 'overpass';
    err.httpStatus = res.status;
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch (_parseErr) {
    const err = new Error('Overpass JSON inválido');
    err.code = 'OSM_INVALID_JSON';
    err.errorStage = 'overpass';
    err.httpStatus = res.status;
    throw err;
  }

  const remarkErr = extractRemarkError(data);
  if (remarkErr) {
    const err = new Error('Overpass remark: ' + remarkErr);
    err.code = 'OSM_REMARK';
    err.errorStage = 'overpass';
    err.httpStatus = res.status;
    throw err;
  }

  if (!data || !Array.isArray(data.elements)) {
    const err = new Error('Overpass resposta sem elements[]');
    err.code = 'OSM_INVALID_BODY';
    err.errorStage = 'overpass';
    err.httpStatus = res.status;
    throw err;
  }

  return data;
}

/**
 * Try Overpass endpoints in order; fallback only on transient failures.
 * Non-transient errors (e.g. HTTP 400) fail immediately.
 */
async function fetchOverpassWithFallback(ql, timeoutMs) {
  const endpoints = resolveOverpassEndpoints();
  let lastErr = null;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    try {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, Math.min(350 * i, 2000)));
      }
      return await fetchOverpassOnce(endpoint, ql, timeoutMs);
    } catch (err) {
      if (err && !err.errorStage) err.errorStage = 'overpass';
      lastErr = err;
      const status = err && err.httpStatus != null ? Number(err.httpStatus) : null;
      // Do not fallback on client/query errors (4xx except 429)
      if (status != null && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (!isTransientError(err)) {
        throw err;
      }
      // continue to next endpoint
    }
  }

  throw lastErr || Object.assign(new Error('Overpass indisponível'), {
    code: 'OSM_UNAVAILABLE',
    errorStage: 'overpass',
  });
}

async function search(criteria) {
  if (!isConfigured()) {
    return { status: 'not_configured', results: [], errorCode: 'NOT_CONFIGURED', errorMessage: 'OSM disabled' };
  }
  try {
    const center = await geocodeLocation(criteria.location);
<<<<<<< HEAD
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
=======
    if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) {
      return okResult([]);
    }
    const radius = Math.min(
      Math.max(parseInt(process.env.OSM_SEARCH_RADIUS_M || '5000', 10) || 5000, 500),
      25000
    );
    const limit = Math.min(criteria.limit || 50, 100);
    const ql = buildOverpassQuery(
      criteria.query,
      radius,
      center.lat,
      center.lon,
      limit,
      center
    );

    let data;
    try {
      data = await fetchOverpassWithFallback(ql, DEFAULT_TIMEOUT_MS);
    } catch (err) {
      if (err && !err.errorStage) err.errorStage = 'overpass';
      throw err;
    }

    const elements = Array.isArray(data.elements) ? data.elements : [];
    const seen = new Set();
    const mapped = [];
    for (const el of elements) {
      const item = mapElement(el, criteria);
      if (!item) continue;
      const key = item.externalId || `${item.name}|${item.address}|${item.phone}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mapped.push(item);
      if (mapped.length >= limit) break;
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
    }
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const mapped = elements.map((el) => mapElement(el, criteria)).filter(Boolean).slice(0, limit);
    return okResult(mapped);
  } catch (err) {
    const stage = (err && err.errorStage) || 'osm_search';
    const httpStatus = err && err.httpStatus != null ? err.httpStatus : null;
    const code = resolveErrorCode(err);
    const causeCode = resolveCauseCode(err);
    const errorName = resolveErrorName(err);
    const message = sanitizeOsmErrorMessage(err);
    return {
      status: 'error',
      results: [],
      errorCode: code,
      errorMessage: message,
      errorStage: stage,
      httpStatus,
      errorName,
      causeCode: causeCode && causeCode !== code ? causeCode : causeCode,
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
  resolveErrorCode,
  resolveCauseCode,
<<<<<<< HEAD
=======
  geocodeLocation,
  resolveOverpassEndpoints,
  extractRemarkError,
  isTransientError,
>>>>>>> 5a08e2e (fix(osm): improve search coverage and Overpass resilience)
};
