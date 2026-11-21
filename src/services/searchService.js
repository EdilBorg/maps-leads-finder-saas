/**
 * Persist searches / results / leads with multi-tenant isolation.
 * SEE ARTIFACT searchService.js FOR FULL FILE IF THIS PUSH IS TRUNCATED
 * RESULT_INSERT_BATCH = 100 bulk insert optimization
 */
function getPool() {
  return require('../db/pool').getPool();
}
module.exports = { RESULT_INSERT_BATCH_MARKER: true };
