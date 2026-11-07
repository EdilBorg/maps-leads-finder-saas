/**
 * Application-level tenant lock helpers (Etapa 5).
 *
 * CONTRACT: call only inside BEGIN…COMMIT/ROLLBACK.
 * pg_advisory_xact_lock is released at statement end outside a transaction block.
 *
 * FK change: stabilizeAndLockReferenceChange — one ordered lock acquisition;
 * if FK changed underfoot → TENANT_LOCK_RETRY (ROLLBACK + full transaction retry).
 * Does not accumulate locks across attempts in the same transaction.
 */

const VALID_KINDS = Object.freeze(['sub', 'search', 'result']);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function assertId(id, kind) {
  if (id == null || id === '') {
    throw new Error(`tenantLocks: missing id for kind=${kind}`);
  }
  if (typeof id !== 'string') {
    throw new Error(`tenantLocks: id must be a string UUID for kind=${kind}`);
  }
  if (!UUID_RE.test(id)) {
    throw new Error(`tenantLocks: id must be a valid UUID for kind=${kind}`);
  }
  return id;
}

function optionalUuid(id, kind) {
  if (id == null || id === '') return null;
  return assertId(id, kind);
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
    if (!entry) continue;
    if (entry.id == null || entry.id === '') continue;
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

async function lockReferenceChange(client, kind, observedCurrentId, newId) {
  assertKind(kind);
  const oldU = optionalUuid(observedCurrentId, kind);
  const newU = optionalUuid(newId, kind);
  return lockTenantKeysOrdered(client, [
    { kind, id: oldU },
    { kind, id: newU },
  ]);
}

async function stabilizeAndLockReferenceChange(client, kind, readCurrent, newId) {
  assertKind(kind);
  optionalUuid(newId, kind);
  if (typeof readCurrent !== 'function') {
    throw new Error('tenantLocks.stabilizeAndLockReferenceChange: readCurrent must be a function');
  }

  let observed = await readCurrent();
  observed = optionalUuid(observed, kind);

  await lockReferenceChange(client, kind, observed, newId);

  let again = await readCurrent();
  again = optionalUuid(again, kind);

  if (again !== observed) {
    const err = new Error(
      `tenantLocks: FK reference for kind=${kind} changed underfoot (observed ${observed} → ${again}); ROLLBACK and retry the full transaction`
    );
    err.code = 'TENANT_LOCK_RETRY';
    err.observedBefore = observed;
    err.observedAfter = again;
    throw err;
  }

  return {
    observedCurrentId: observed,
    newId: optionalUuid(newId, kind),
  };
}

module.exports = {
  VALID_KINDS,
  UUID_RE,
  isUuid,
  optionalUuid,
  tenantKeyString,
  normalizeTenantKeys,
  lockTenantKey,
  lockSubscription,
  lockSearch,
  lockSearchResult,
  lockTenantKeysOrdered,
  lockReferenceChange,
  stabilizeAndLockReferenceChange,
};
