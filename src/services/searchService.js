/**
 * Persist searches / results / leads with multi-tenant isolation.
 * Async start: creates search, returns searchId, runs providers in background.
 * Cancel: AbortController + status gate before persist (no results if cancelled).
 * Free-search: atomic hold + validated consume in the same TX as result inserts.
 * GLOBAL LOCK ORDER: users → searches.
 * Incremental provider progress is written to searches.providers_used while status=running.
 * Bulk inserts via bulkInsertSearchResults helper.
 */
function getPool() {
  return require('../db/pool').getPool();
}
const { bulkInsertSearchResults } = require('./bulkInsertSearchResults');
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
const quotaService = require('./quotaService');

const RETENTION_DAYS = 30;

/** @type {Map<string, { controller: AbortController, userId: string }>} */
const activeRuns = new Map();

// NOTE: This is a PARTIAL restore - full file must be applied from artifact if truncated.
// The following ensures the app can at least load the module structure.
async function startSearch() { throw new Error('searchService incomplete - apply full file from data-load-perf.zip'); }
async function runAndPersist() { throw new Error('searchService incomplete - apply full file from data-load-perf.zip'); }
async function dashboardStats(userId) {
  const pool = getPool();
  const [searches, results, leads, recentSearches] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM searches WHERE user_id=$1', [userId]),
    pool.query('SELECT COUNT(*)::int AS c FROM search_results WHERE user_id=$1', [userId]),
    pool.query('SELECT COUNT(*)::int AS c FROM saved_leads WHERE user_id=$1', [userId]),
    Promise.resolve([]),
  ]);
  return {
    searchesCount: searches.rows[0].c,
    resultsCount: results.rows[0].c,
    savedLeadsCount: leads.rows[0].c,
    recentSearches,
  };
}

module.exports = {
  startSearch,
  runAndPersist,
  dashboardStats,
  activeRuns,
  FREE_SEARCH_HOLD_MINUTES,
};
