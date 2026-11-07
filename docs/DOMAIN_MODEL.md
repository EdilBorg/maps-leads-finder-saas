# Domain model (Etapa 5)

Migrations 001–007 (unchanged history). Helpers: `src/db/tenantLocks.js`, SQL `lock_tenant_*`.

## Multi-tenant isolation

| Relation | Rule |
|----------|------|
| payments → subscriptions | same `user_id` |
| saved_leads → searches | same `user_id` for origin |
| search_results → searches | composite `(search_id, user_id)` |
| is_duplicate_of | same search + user; no self-ref |

## Advisory lock contract

`pg_advisory_xact_lock` is **transaction-scoped**.

- Must be used only after `BEGIN` and before `COMMIT`/`ROLLBACK`.
- Outside an explicit transaction, PostgreSQL may release the lock at the end of the statement — a later `UPDATE` is **not** protected.
- `COMMIT` and `ROLLBACK` both release transaction advisory locks.
- node-pg does not expose a reliable portable “am I in a transaction?” API for all modes; callers **must** open `BEGIN` themselves. Helpers do not claim to detect this automatically.

## FK change protocol (old + new, concurrent-safe)

**Do not** take `SELECT … FOR UPDATE` on the child/parent **before** advisory locks (lock-order inversion / deadlock risk).

```js
const { stabilizeAndLockReferenceChange } = require('../src/db/tenantLocks');

await client.query('BEGIN');
try {
  const paymentId = '…'; // UUID
  const newSubscriptionId = '…'; // UUID or null

  const { observedCurrentId } = await stabilizeAndLockReferenceChange(
    client,
    'sub',
    async () => {
      const { rows } = await client.query(
        `SELECT subscription_id FROM payments WHERE id = $1`,
        [paymentId]
      );
      if (!rows[0]) throw new Error('payment not found');
      return rows[0].subscription_id;
    },
    newSubscriptionId
  );

  const upd = await client.query(
    `UPDATE payments
     SET subscription_id = $1
     WHERE id = $2
       AND subscription_id IS NOT DISTINCT FROM $3`,
    [newSubscriptionId, paymentId, observedCurrentId]
  );
  if (upd.rowCount !== 1) {
    throw Object.assign(new Error('concurrent FK change'), { code: 'CONCURRENT_FK_CHANGE' });
  }

  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
}
```

Same protocol for `saved_leads.origin_search_id` (`'search'`) and `search_results.is_duplicate_of` (`'result'`).

IDs must be RFC UUID strings; invalid strings are rejected before SQL.

## Triggers

Enforce multi-tenant predicates; not a substitute for application pre-locking.

## Migration runner

Session `pg_advisory_lock` for DDL. On unlock failure: `client.release(true)` (destroy), not returned to the pool.

## Error codes

| SQLSTATE | Meaning |
|----------|---------|
| `23514` | check_violation |
| `23503` | foreign_key_violation |
| `40P01` | deadlock_detected — retry whole xact if idempotent |
| `40001` | serialization_failure — not a deadlock |

## Limitations

- Without this protocol, concurrent parent/child updates may deadlock (`40P01`).  
- Stabilization may fail (`TENANT_LOCK_UNSTABLE`) under extreme contention.  
- PostgreSQL integration tests: **pending**.

```bash
export NODE_ENV=test ALLOW_DB_TESTS=1
export DATABASE_URL=postgresql://USER:PASS@localhost:5432/maps_leads_finder_test
npm run migrate && npm run migrate && npm test
```
