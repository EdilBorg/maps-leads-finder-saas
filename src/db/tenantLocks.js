/**
 * Application-level tenant lock helpers (Etapa 5).
 *
 * Call at the *start* of a transaction, before any INSERT/UPDATE on related tables.
 * Keys must match migrations/006–007: sub:|search:|result:
 *
 * When changing a foreign key, lock BOTH the old and new parent keys (when non-null)
 * via lockReferenceChange / lockTenantKeysOrdered before the UPDATE.
 */

const VALID_KINDS = Object.freeze(['sub', 'search', 'result']);

function assertId(id, kind) {
  if (id == null || id === '') {
    throw new Error(`tenantLocks: missing id for kind=${kind}`);
  }
  if (typeof id !== 'string') {
    throw new Error(`tenantLocks: id must be a string UUID for kind=${kind}`);
  }
  return id;
}

function assertKind(kind) {
  if (!VALID_KINDS.includes(kind)) {
    throw new Error(`tenantLocks: invalid kind=${kind}; expected one of ${VALID_KINDS.join('|')}`);
  }
  return kind;
}

function tenantKeyString(kind, id) {
  return `${assertKind(kind)}:${assertId(id, kind)}`;
}

async function lockTenantKey(client, kind, id) {
  const k = assertKind(kind);
  const i = assertId(id, k);
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1 || $2::text))`,
    [`${k}:`, i]
  );
}

async function lockSubscription(client, subscriptionId) {
  return lockTenantKey(client, 'sub', subscriptionId);
}

async function lockSearch(client, searchId) {
  return lockTenantKey(client, 'search', searchId);
}

async function lockSearchResult(client, resultId) {
  return lockTenantKey(client, 'result', resultId);
}

function normalizeTenantKeys(keys) {
  if (!Array.isArray(keys)) {
    throw new Error('tenantLocks.normalizeTenantKeys: keys must be an array');
  }
  const seen = new Set();
  const out = [];
  for (const entry of keys) {
    if (!entry || entry.id == null || entry.id === '') continue;
    const kind = assertKind(entry.kind);
    const id = assertId(entry.id, kind);
    const canon = tenantKeyString(kind, id);
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push({ kind, id });
  }
  out.sort((a, b) => {
    const ka = tenantKeyString(a.kind, a.id);
    const kb = tenantKeyString(b.kind, b.id);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

async function lockTenantKeysOrdered(client, keys) {
  const ordered = normalizeTenantKeys(keys);
  for (const k of ordered) {
    await lockTenantKey(client, k.kind, k.id);
  }
  return ordered;
}

async function lockReferenceChange(client, kind, oldId, newId) {
  assertKind(kind);
  return lockTenantKeysOrdered(client, [
    { kind, id: oldId },
    { kind, id: newId },
  ]);
}

module.exports = {
  VALID_KINDS,
  tenantKeyString,
  normalizeTenantKeys,
  lockTenantKey,
  lockSubscription,
  lockSearch,
  lockSearchResult,
  lockTenantKeysOrdered,
  lockReferenceChange,
};
