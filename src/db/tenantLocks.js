/**
 * Application-level tenant lock helpers (Etapa 5).
 *
 * PostgreSQL locks the target row of an UPDATE *before* BEFORE ROW triggers run.
 * Therefore advisory locks taken only inside triggers cannot establish a global
 * order relative to that implicit row lock, and concurrent parent/child updates
 * can still deadlock (40P01).
 *
 * Call these helpers at the *start* of a transaction, before any INSERT/UPDATE
 * on payments, subscriptions, saved_leads, searches, or search_results that
 * participate in multi-tenant integrity checks.
 *
 * Keys must match migrations/006–007:
 *   sub:<subscriptionId> | search:<searchId> | result:<resultId>
 */

/**
 * Invoke PostgreSQL hashtext so keys match trigger locks.
 * @param {import('pg').PoolClient} client
 * @param {'sub'|'search'|'result'} kind
 * @param {string} id UUID
 */
async function lockTenantKey(client, kind, id) {
  if (!id) {
    throw new Error(`tenantLocks.lockTenantKey: missing id for kind=${kind}`);
  }
  if (!['sub', 'search', 'result'].includes(kind)) {
    throw new Error(`tenantLocks.lockTenantKey: invalid kind=${kind}`);
  }
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1 || $2::text))`,
    [`${kind}:`, id]
  );
}

/** @param {import('pg').PoolClient} client @param {string} subscriptionId */
async function lockSubscription(client, subscriptionId) {
  return lockTenantKey(client, 'sub', subscriptionId);
}

/** @param {import('pg').PoolClient} client @param {string} searchId */
async function lockSearch(client, searchId) {
  return lockTenantKey(client, 'search', searchId);
}

/** @param {import('pg').PoolClient} client @param {string} resultId */
async function lockSearchResult(client, resultId) {
  return lockTenantKey(client, 'result', resultId);
}

/**
 * Lock multiple keys in lexicographic order to reduce multi-entity deadlocks.
 * @param {import('pg').PoolClient} client
 * @param {Array<{ kind: 'sub'|'search'|'result', id: string }>} keys
 */
async function lockTenantKeysOrdered(client, keys) {
  const sorted = [...keys].sort((a, b) => {
    const ka = `${a.kind}:${a.id}`;
    const kb = `${b.kind}:${b.id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const k of sorted) {
    await lockTenantKey(client, k.kind, k.id);
  }
}

module.exports = {
  lockTenantKey,
  lockSubscription,
  lockSearch,
  lockSearchResult,
  lockTenantKeysOrdered,
};
