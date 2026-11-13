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
