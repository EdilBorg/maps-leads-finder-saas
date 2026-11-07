# Domain model (Etapa 5)

Migrations:

1. `001_auth.sql` — users, sessions, tokens  
2. `002_fix_session_oids.sql` — session compatibility  
3. `003_domain_model.sql` — domain tables  
4. `004_domain_integrity_fixes.sql` — child INSERT/UPDATE same-tenant checks  
5. `005_domain_update_integrity.sql` — parent UPDATE protection + row locks  
6. `006_domain_lock_ordering.sql` — advisory locks inside triggers (defense in depth)  
7. `007_domain_tenant_lock_helpers.sql` — SQL lock helpers + strategy notes  

## Multi-tenant isolation

| Relation | Child INSERT/UPDATE | Parent UPDATE |
|----------|-------------------|---------------|
| payments → subscriptions | `user_id` must equal `subscriptions.user_id` | Cannot change `subscriptions.user_id` while payments reference it |
| saved_leads → searches | `user_id` must equal origin `searches.user_id` | Cannot change `searches.user_id` while leads/results reference it |
| search_results → searches | Composite FK `(search_id, user_id)` | Same for results |
| is_duplicate_of | Same `search_id` + `user_id`; no self-ref | Cannot move a result targeted by `is_duplicate_of` |

Application queries must still filter by `user_id`.

## Concurrency strategy

### Implicit locks

On `UPDATE`/`DELETE`, PostgreSQL acquires the **row exclusive lock on the target row before BEFORE ROW triggers run**. Advisory locks taken *only* inside those triggers cannot establish an order relative to that first row lock.

### Application locks (required)

At the **start** of a transaction, **before** mutating related rows:

- JS: `src/db/tenantLocks.js`  
- SQL: `lock_tenant_subscription` / `lock_tenant_search` / `lock_tenant_search_result`

**Changing a FK** requires locking **both** the old and the new parent (when non-null), in deterministic order via `lockReferenceChange`.

```js
const { lockReferenceChange } = require('../src/db/tenantLocks');

// payment.subscription_id: A → B
await client.query('BEGIN');
try {
  await lockReferenceChange(client, 'sub', oldSubscriptionId, newSubscriptionId);
  await client.query(
    `UPDATE payments SET subscription_id = $1 WHERE id = $2 AND user_id = $3`,
    [newSubscriptionId, paymentId, userId]
  );
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
}
```

```js
// saved_leads.origin_search_id: SEARCH_A → SEARCH_B
await client.query('BEGIN');
try {
  await lockReferenceChange(client, 'search', oldSearchId, newSearchId);
  await client.query(
    `UPDATE saved_leads SET origin_search_id = $1 WHERE id = $2 AND user_id = $3`,
    [newSearchId, leadId, userId]
  );
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
}
```

```js
// search_results.is_duplicate_of: RESULT_A → RESULT_B
await client.query('BEGIN');
try {
  await lockReferenceChange(client, 'result', oldDupId, newDupId);
  await client.query(
    `UPDATE search_results SET is_duplicate_of = $1 WHERE id = $2 AND user_id = $3`,
    [newDupId, resultId, userId]
  );
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
}
```

`lockReferenceChange` skips null ids and deduplicates when old === new.

### Session vs transaction advisory locks

| API | Scope | Used for |
|-----|--------|----------|
| `pg_advisory_lock` | **Session** | Migration runner |
| `pg_advisory_xact_lock` | **Transaction** | Tenant ops (released on COMMIT/ROLLBACK) |

### Migration runner safety

`src/db/migrate.js` takes a session lock for the run. On completion it calls `pg_advisory_unlock_all()`. If lock release cannot be confirmed, the client is **destroyed** (`client.release(true)`) and **not** returned to the pool.

### Error codes

| SQLSTATE | Meaning | Guidance |
|----------|---------|----------|
| `23514` | check_violation | Fix request |
| `23503` | foreign_key_violation | Fix request |
| `40P01` | deadlock_detected | Retry entire transaction only if idempotent |
| `40001` | serialization_failure | Not a deadlock |

## Limitations

- Without application pre-locking, concurrent parent/child updates may deadlock (`40P01`).  
- PostgreSQL integration test execution is **pending** until the deploy/test environment is available.

## Running PostgreSQL tests later

```bash
export NODE_ENV=test
export ALLOW_DB_TESTS=1
export DATABASE_URL=postgresql://USER:PASS@localhost:5432/maps_leads_finder_test
npm install
npm run migrate
npm run migrate
npm test
```
