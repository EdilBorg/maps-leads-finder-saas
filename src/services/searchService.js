/**
 * Persist searches / results / leads with multi-tenant isolation.
 * Async start: creates search, returns searchId, runs providers in background.
 * Cancel: AbortController + status gate before persist (no results if cancelled).
 * Free-search: atomic hold + validated consume in the same TX as result inserts.
 * GLOBAL LOCK ORDER: users → searches.
 * Incremental provider progress is written to searches.providers_used while status=running.
 */
function getPool() {
  return require('../db/pool').getPool();
}
const {
  executeSearch,
  publicLead,
  clientMessageForOutcome,
  clientHintForOutcome,
  normalizeLimit,
  leadIdentityKey,
} = require('./searchEngine');
const {
  acquireFreeSearchHold,
  bindHoldToSearch,
  renewFreeSearchHold,
  consumeFreeSearchHold,
  releaseFreeSearchHold,
  lockUserForUpdate,
  recoverAbandonedSearches,
  FREE_SEARCH_HOLD_MINUTES,
  FREE_SEARCH_RENEW_INTERVAL_MS,
} = require('./freeSearchHold');

const RETENTION_DAYS = 30;

/** @type {Map<string, { controller: AbortController, userId: string }>} */
const activeRuns = new Map();

function mapPublicRow(r, i) {
  const raw = r.raw_payload && typeof r.raw_payload === 'object' ? r.raw_payload : {};
  return publicLead({
    id: r.id, name: r.name, address: r.address, phone: r.phone, email: r.email, website: r.website,
    rating: r.rating != null ? Number(r.rating) : null, reviewsCount: r.reviews_count,
    category: r.category, lat: r.lat, lng: r.lng,
    photoUrl: raw.photoUrl || null,
    googleMapsUrl: raw.googleMapsUrl || raw.url || null,
    googlePlaceId: raw.placeId || raw.googlePlaceId || null,
    sourceProvider: r.source_provider || null,
    externalId: r.external_id || null,
    raw,
  }, i);
}

function mapProviderUiStatus(status, errorCode) {
  if (errorCode === 'CANCELLED' || status === 'cancelled') return 'cancelled';
  if (status === 'ok') return 'completed';
  if (status === 'empty') return 'no_results';
  if (status === 'not_configured') return 'not_configured';
  if (status === 'running' || status === 'pending') return status;
  return 'failed';
}

function markPendingProvidersCancelled(providers) {
  if (!Array.isArray(providers)) return [];
  return providers.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const st = p.status;
    if (st === 'pending' || st === 'running') {
      return { ...p, status: 'cancelled' };
    }
    return p;
  });
}

const {
  listSavedLeads,
  getSavedLead,
  updateSavedLead,
  CRM_STATUSES,
  CRM_NOTES_MAX,
  isValidCrmStatus,
} = require('./savedLeadsCrm');

module.exports = {
  startSearch: async function startSearch() { throw new Error('searchService incomplete restore - see report'); },
  listSavedLeads,
  getSavedLead,
  updateSavedLead,
  CRM_STATUSES,
  CRM_NOTES_MAX,
  isValidCrmStatus,
};
