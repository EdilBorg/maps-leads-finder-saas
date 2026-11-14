/**
 * OSM commercial/place search: Nominatim geocode + Overpass POI query.
 * Compact nwr selectors, AbortController timeouts, multi-endpoint fallback.
 */
const { withTimeout, okResult } = require('./baseProvider');
const CODE = 'osm';

/** Client timeout must exceed Overpass [timeout:N] so the server can finish. */
const OSM_OVERPASS_TIMEOUT_MS = 45000;
const OSM_GEOCODE_TIMEOUT_MS = 15000;
const OVERPASS_SERVER_TIMEOUT_S = 25;

/** VK Maps first, then public Overpass mirrors. */
const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Max bbox span (degrees) for a single Overpass query before cell split. */
const CELL_MAX_SPAN_DEG = parseFloat(process.env.OSM_CELL_MAX_SPAN_DEG || '0.25') || 0.25;
/** Max cells processed in one search() invocation. */
const MAX_CELLS_PER_SEARCH = Math.min(Math.max(parseInt(process.env.OSM_MAX_CELLS_PER_SEARCH || '16', 10) || 16, 1), 64);
/** Concurrent cell queries. */
const CELL_CONCURRENCY = Math.min(Math.max(parseInt(process.env.OSM_CELL_CONCURRENCY || '2', 10) || 2, 1), 4);
/** Delay between cell batches (ms). */
const CELL_BATCH_DELAY_MS = Math.min(Math.max(parseInt(process.env.OSM_CELL_BATCH_DELAY_MS || '200', 10) || 200, 0), 5000);

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
      'cafeteria', 'cafeterias', 'pastelaria', 'pastelarias',
    ],
  },
  {
    id: 'pharmacies',
    tags: [{ key: 'amenity', value: 'pharmacy' }],
    aliases: [
      'farmacia', 'farmacias', 'farmácia', 'farmácias',
      'pharmacy', 'pharmacies',
    ],
  },
  {
    id: 'clinics',
    tags: [
      { key: 'amenity', value: 'clinic' },
      { key: 'amenity', value: 'doctors' },
      { key: 'healthcare', value: 'clinic' },
    ],
    aliases: [
      'clinica', 'clinicas', 'clínica', 'clínicas',
      'clinic', 'clinics', 'medico', 'médico', 'medicos', 'médicos',
      'saude', 'saúde',
    ],
  },
  {
    id: 'dentists',
    tags: [{ key: 'amenity', value: 'dentist' }],
    aliases: [
      'clinica dentaria', 'clinicas dentarias', 'clínica dentária', 'clínicas dentárias',
      'clinica dentária', 'clínica dentaria', 'dentista', 'dentistas',
      'dentist', 'dentists', 'dental',
    ],
  },
  {
    id: 'beauty',
    tags: [
      { key: 'shop', value: 'beauty' },
      { key: 'shop', value: 'hairdresser' },
      { key: 'craft', value: 'hairdresser' },
    ],
    aliases: [
      'salao de beleza', 'saloes de beleza', 'salão de beleza', 'salões de beleza',
      'salao de belesa', 'cabeleireiro', 'cabeleireiros', 'cabeleireira', 'cabeleireiras',
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

function endpointHost(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch (_) {
    return String(endpoint).slice(0, 64);
  }
}

/**
 * Fetch with AbortController so the HTTP request is actually cancelled on timeout.
 */
async function fetchWithAbort(url, init, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch (_) {}
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      const e = new Error(`${label || 'fetch'} timeout after ${timeoutMs}ms`);
      e.code = 'PROVIDER_TIMEOUT';
      e.errorStage = label && label.includes('geocode') ? 'geocode' : 'overpass';
      e.cause = err;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geocode via Nominatim. Returns { lat, lon, bbox? }.
 */
async function geocodeLocation(location) {
  const base = process.env.OSM_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
  const url = `${base}/search?q=${encodeURIComponent(location)}&format=json&limit=1`;
  try {
    const res = await fetchWithAbort(
      url,
      { headers: { 'User-Agent': userAgent(), Accept: 'application/json' } },
      OSM_GEOCODE_TIMEOUT_MS,
      'osm-geocode'
    );
    if (!res.ok) {
      const err = new Error(`geocode HTTP ${res.status}`);
      err.code = 'HTTP_ERROR';
      err.errorStage = 'geocode';
      err.httpStatus = res.status;
      throw err;
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data[0]) return null;
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
 * Split a bounding box into cells of at most maxSpan degrees on each side.
 * Used for city/region/country-scale searches so each Overpass query stays small.
 */
function splitBboxIntoCells(bbox, maxSpan = CELL_MAX_SPAN_DEG) {
  if (!bbox) return [];
  const { south, west, north, east } = bbox;
  const latSpan = north - south;
  const lonSpan = east - west;
  if (!(latSpan > 0) || !(lonSpan > 0)) return [];
  const rows = Math.max(1, Math.ceil(latSpan / maxSpan));
  const cols = Math.max(1, Math.ceil(lonSpan / maxSpan));
  const cellH = latSpan / rows;
  const cellW = lonSpan / cols;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        south: south + r * cellH,
        north: south + (r + 1) * cellH,
        west: west + c * cellW,
        east: west + (c + 1) * cellW,
        row: r,
        col: c,
      });
    }
  }
  return cells;
}

/**
 * Build Overpass area filter for a geo target.
 * - Small bbox: use bbox directly.
 * - Large bbox: caller should split into cells; single-cell path still uses bbox.
 * - No bbox: around:radius from center.
 */
function areaFilter(geo, radius) {
  if (geo && geo.bbox) {
    const { south, west, north, east } = geo.bbox;
    return `(${south},${west},${north},${east})`;
  }
  return `(around:${radius},${geo.lat},${geo.lon})`;
}

/**
 * Compact nwr tag filters (one line per tag group, not 3× node/way/relation).
 */
function tagFilterLines(tags, area) {
  const lines = [];
  const byKey = groupTagsByKey(tags);
  for (const [key, values] of byKey.entries()) {
    const anyValue = values.some((v) => v == null);
    let filter;
    if (anyValue) {
      filter = '["' + key + '"]';
    } else if (values.length === 1) {
      filter = '["' + key + '"="' + values[0] + '"]';
    } else {
      const reg = values.map((v) => escapeOverpassRegex(String(v))).join('|');
      filter = '["' + key + '"~"^(' + reg + ')$"]';
    }
    lines.push('  nwr' + filter + area + ';');
  }
  return lines;
}

/**
 * Compact nwr name filters.
 */
function nameFilterLines(qEscaped, area, withCommercialKeys) {
  const lines = [];
  lines.push('  nwr["name"~"' + qEscaped + '",i]' + area + ';');
  if (withCommercialKeys) {
    const keys = ['amenity', 'shop', 'craft', 'office', 'tourism'];
    for (const key of keys) {
      lines.push('  nwr["' + key + '"]["name"~"' + qEscaped + '",i]' + area + ';');
    }
  }
  return lines;
}

/**
 * Build Overpass QL with compact nwr selectors.
 * Signature: buildOverpassQuery(query, radius, lat, lon, limit [, geo])
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
    lines.push(...tagFilterLines(category.tags, area));
    if (qEscaped) {
      lines.push(...nameFilterLines(qEscaped, area, false));
    }
  } else if (qEscaped) {
    lines.push(...nameFilterLines(qEscaped, area, true));
  } else {
    lines.push('  node(0);');
  }

  return (
    '[out:json][timeout:' +
    OVERPASS_SERVER_TIMEOUT_S +
    '];\n(\n' +
    lines.join('\n') +
    '\n);\nout center ' +
    outLimit +
    ';'
  ).trim();
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
    category: tags.amenity || tags.shop || tags.office || tags.tourism || tags.healthcare || tags.leisure || tags.craft || criteria.query,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lon) ? lon : null,
    sourceProvider: CODE,
    externalId: `${el.type || 'n'}/${el.id}`,
    raw: { osm_type: el.type, osm_id: el.id },
  };
}

function resolveOverpassEndpoints() {
  const list = DEFAULT_OVERPASS_ENDPOINTS.slice();
  const extra = process.env.OSM_OVERPASS_URL;
  if (extra && String(extra).trim()) {
    const url = String(extra).trim();
    // Prepend custom URL if not already first; keep full fallback chain.
    if (!list.includes(url)) {
      list.unshift(url);
    } else {
      // Move to front
      list.splice(list.indexOf(url), 1);
      list.unshift(url);
    }
  }
  return list;
}

/**
 * One Overpass attempt with real AbortController cancellation and JSON read guard.
 */
async function fetchOverpassOnce(endpoint, ql, timeoutMs) {
  const host = endpointHost(endpoint);
  const started = Date.now();
  let res;
  try {
    res = await fetchWithAbort(
      endpoint,
      {
        method: 'POST',
        headers: {
          'User-Agent': userAgent(),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(ql)}`,
      },
      timeoutMs,
      'osm-overpass'
    );
  } catch (err) {
    if (err && !err.errorStage) err.errorStage = 'overpass';
    err.endpointHost = host;
    throw err;
  }

  const durationMs = Date.now() - started;

  if (!res.ok) {
    const err = new Error(`overpass HTTP ${res.status}`);
    err.code = 'HTTP_ERROR';
    err.errorStage = 'overpass';
    err.httpStatus = res.status;
    err.endpointHost = host;
    err.durationMs = durationMs;
    throw err;
  }

  const remaining = Math.max(2000, timeoutMs - durationMs);
  let data;
  try {
    data = await withTimeout(res.json(), remaining, 'osm-overpass-json');
  } catch (parseErr) {
    const code = resolveErrorCode(parseErr);
    const err = new Error(
      code === 'PROVIDER_TIMEOUT'
        ? 'Overpass timeout ao ler resposta JSON'
        : 'Overpass JSON inválido'
    );
    err.code = code === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'OSM_INVALID_JSON';
    err.errorStage = 'overpass';
    err.httpStatus = res.status;
    err.endpointHost = host;
    err.durationMs = Date.now() - started;
    throw err;
  }

  const remarkErr = extractRemarkError(data);
  if (remarkErr) {
    const err = new Error('Overpass remark: ' + remarkErr);
    err.code = 'OSM_REMARK';
    err.errorStage = 'overpass';
    err.httpStatus = res.status;
    err.endpointHost = host;
    err.durationMs = Date.now() - started;
    throw err;
  }

  if (!data || !Array.isArray(data.elements)) {
    const err = new Error('Overpass resposta sem elements[]');
    err.code = 'OSM_INVALID_BODY';
    err.errorStage = 'overpass';
    err.httpStatus = res.status;
    err.endpointHost = host;
    err.durationMs = Date.now() - started;
    throw err;
  }

  return { data, durationMs, host };
}

/**
 * Try endpoints in order; fallback only on transient failures.
 * Logs each attempt: host, attempt number, duration, status/code, outcome.
 */
async function fetchOverpassWithFallback(ql, timeoutMs) {
  const endpoints = resolveOverpassEndpoints();
  let lastErr = null;

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    const host = endpointHost(endpoint);
    const attempt = i + 1;
    try {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, Math.min(350 * i, 2000)));
      }
      const result = await fetchOverpassOnce(endpoint, ql, timeoutMs);
      console.log(
        JSON.stringify({
          provider: CODE,
          stage: 'overpass',
          host,
          attempt,
          durationMs: result.durationMs,
          ok: true,
          elements: Array.isArray(result.data.elements) ? result.data.elements.length : 0,
        })
      );
      return result.data;
    } catch (err) {
      if (err && !err.errorStage) err.errorStage = 'overpass';
      lastErr = err;
      const status = err && err.httpStatus != null ? Number(err.httpStatus) : null;
      const code = resolveErrorCode(err);
      console.warn(
        JSON.stringify({
          provider: CODE,
          stage: 'overpass',
          host: err.endpointHost || host,
          attempt,
          durationMs: err.durationMs != null ? err.durationMs : null,
          ok: false,
          httpStatus: status,
          errorCode: code,
        })
      );
      if (status != null && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }
      if (!isTransientError(err)) {
        throw err;
      }
    }
  }

  throw lastErr || Object.assign(new Error('Overpass indisponível'), {
    code: 'OSM_UNAVAILABLE',
    errorStage: 'overpass',
  });
}

/**
 * Query one geographic cell (or full area when no split).
 * Returns mapped leads; throws only on hard failure of all endpoints.
 */
async function queryCell(criteria, geo, radius, limit) {
  const ql = buildOverpassQuery(criteria.query, radius, geo.lat, geo.lon, limit, geo);
  const data = await fetchOverpassWithFallback(ql, OSM_OVERPASS_TIMEOUT_MS);
  const elements = Array.isArray(data.elements) ? data.elements : [];
  const mapped = [];
  for (const el of elements) {
    const item = mapElement(el, criteria);
    if (item) mapped.push(item);
  }
  return mapped;
}

async function search(criteria) {
  if (!isConfigured()) {
    return { status: 'not_configured', results: [], errorCode: 'NOT_CONFIGURED', errorMessage: 'OSM disabled' };
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

    // Build list of geo targets (cells or single area)
    let geos = [];
    if (center.bbox) {
      const { south, north, west, east } = center.bbox;
      const latSpan = north - south;
      const lonSpan = east - west;
      if (latSpan > CELL_MAX_SPAN_DEG || lonSpan > CELL_MAX_SPAN_DEG) {
        let cells = splitBboxIntoCells(center.bbox, CELL_MAX_SPAN_DEG);
        if (cells.length > MAX_CELLS_PER_SEARCH) {
          // Cap cells; prefer centre cells first for better local coverage
          const midR = Math.floor(Math.max(...cells.map((c) => c.row)) / 2);
          const midC = Math.floor(Math.max(...cells.map((c) => c.col)) / 2);
          cells = cells
            .map((c) => ({ ...c, dist: Math.abs(c.row - midR) + Math.abs(c.col - midC) }))
            .sort((a, b) => a.dist - b.dist)
            .slice(0, MAX_CELLS_PER_SEARCH);
        }
        geos = cells.map((c) => ({
          lat: (c.south + c.north) / 2,
          lon: (c.west + c.east) / 2,
          bbox: { south: c.south, north: c.north, west: c.west, east: c.east },
        }));
        console.log(
          JSON.stringify({
            provider: CODE,
            stage: 'geocode',
            cells: geos.length,
            latSpan,
            lonSpan,
            maxSpan: CELL_MAX_SPAN_DEG,
          })
        );
      } else {
        geos = [center];
      }
    } else {
      geos = [center];
    }

    const seen = new Set();
    const mapped = [];
    let cellFailures = 0;
    let lastCellErr = null;

    // Process cells with limited concurrency
    for (let i = 0; i < geos.length; i += CELL_CONCURRENCY) {
      if (i > 0 && CELL_BATCH_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, CELL_BATCH_DELAY_MS));
      }
      const batch = geos.slice(i, i + CELL_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (geo) => {
          try {
            return await queryCell(criteria, geo, radius, limit);
          } catch (err) {
            if (err && !err.errorStage) err.errorStage = 'overpass';
            return { __error: err };
          }
        })
      );
      for (const res of results) {
        if (res && res.__error) {
          cellFailures += 1;
          lastCellErr = res.__error;
          continue;
        }
        for (const item of res || []) {
          const key = item.externalId || `${item.name}|${item.address}|${item.phone}`;
          if (seen.has(key)) continue;
          seen.add(key);
          mapped.push(item);
          if (mapped.length >= limit) break;
        }
        if (mapped.length >= limit) break;
      }
      if (mapped.length >= limit) break;
    }

    // All cells failed and no results → surface error
    if (mapped.length === 0 && cellFailures > 0 && cellFailures === geos.length) {
      throw lastCellErr || Object.assign(new Error('Overpass indisponível'), {
        code: 'OSM_UNAVAILABLE',
        errorStage: 'overpass',
      });
    }

    return okResult(mapped.slice(0, limit));
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
  geocodeLocation,
  resolveOverpassEndpoints,
  extractRemarkError,
  isTransientError,
  OSM_OVERPASS_TIMEOUT_MS,
  fetchWithAbort,
  splitBboxIntoCells,
  DEFAULT_OVERPASS_ENDPOINTS,
  CELL_MAX_SPAN_DEG,
  MAX_CELLS_PER_SEARCH,
};
