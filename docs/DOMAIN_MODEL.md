# Domain model (Etapa 5)

Migrations:

1. `001_auth.sql` — users, sessions, tokens  
2. `002_fix_session_oids.sql` — session compatibility  
3. `003_domain_model.sql` — domain tables  
4. `004_domain_integrity_fixes.sql` — child INSERT/UPDATE same-tenant checks  
5. `005_domain_update_integrity.sql` — parent UPDATE protection + row locks  
6. `006_domain_lock_ordering.sql` — advisory locks inside triggers (defense in depth)  
7. `007_domain_tenant_lock_helpers.sql` — SQL lock helpers + explicit strategy notes  

## Multi-tenant isolation

| Relation | Child INSERT/UPDATE | Parent UPDATE |
|----------|-------------------|---------------|
| payments → subscriptions | `user_id` must equal `subscriptions.user_id` | Cannot change `subscriptions.user_id` while payments reference it |
| saved_leads → searches | `user_id` must equal origin `searches.user_id` | Cannot change `searches.user_id` while leads/results reference it |
| search_results → searches | Composite FK `(search_id, user_id)` | Same for results |
| is_duplicate_of | Same `search_id` + `user_id`; no self-ref | Cannot move a result targeted by `is_duplicate_of` |

Application queries must still filter by `user_id`.

## Concurrency strategy (revised)

### Implicit locks

On `UPDATE`/`DELETE`, PostgreSQL acquires the **row exclusive lock on the target row before BEFORE ROW triggers run**. Advisory locks taken *only* inside those triggers therefore cannot establish an order relative to that first row lock.

Classic cycle under concurrent parent/child updates:

1. T1 `UPDATE payments` → locks payment row → trigger wants subscription  
2. T2 `UPDATE subscriptions` → locks subscription row → trigger wants payments  
→ **40P01 deadlock_detected** is possible.

### Required application pattern

At the start of a transaction, **before** mutating related rows, call:

- SQL: `SELECT lock_tenant_subscription(id)` / `lock_tenant_search(id)` / `lock_tenant_search_result(id)`  
- or JS: `src/db/tenantLocks.js` (`lockSubscription`, `lockSearch`, `lockSearchResult`, `lockTenantKeysOrdered`)

Keys (must stay aligned with triggers):

- `hashtext('sub:' || subscription_id)`  
- `hashtext('search:' || search_id)`  
- `hashtext('result:' || result_id)`  

When multiple keys are needed, acquire them in **lexicographic order** of `kind:id` (`lockTenantKeysOrdered`).

### Role of triggers

Triggers enforce multi-tenant **predicates** (same user / same search). They still take the same advisory keys as defense in depth when callers forget pre-locking, but **do not claim deadlock-freedom** under arbitrary concurrent parent/child updates without application pre-locking.

### Error codes

| SQLSTATE | Meaning | Guidance |
|----------|---------|----------|
| `23514` | check_violation (multi-tenant reject) | Fix request; do not retry as success |
| `23503` | foreign_key_violation | Fix request |
| `40P01` | deadlock_detected | Retry **entire** transaction only if idempotent |
| `40001` | serialization_failure | Not a deadlock; retry only under appropriate isolation |

## Migrations runner

`src/db/migrate.js` is the single runner (CLI + tests). It uses a **session** `pg_advisory_lock` for the whole run and releases via `pg_advisory_unlock_all()` before returning the connection to the pool so locks cannot leak to other borrowers.

## Retention vs snapshots

- Deleting a search **cascades** `search_results`.  
- Deleting a search sets `saved_leads.origin_search_id` to **NULL**; snapshot columns remain.

## api_providers secrets

Credentials never in `api_providers.config` — env / secrets manager only.

## Limitations

- Deadlock-free concurrent parent/child updates are **not** guaranteed without application-level `lock_tenant_*`.  
- Long `is_duplicate_of` cycles beyond self-reference are not fully blocked.  
- Integration tests require `ALLOW_DB_TESTS=1` and a database name ending in `_test` (or `TEST_DATABASE_NAME`).

## Running PostgreSQL tests later

```bash
export NODE_ENV=test
export ALLOW_DB_TESTS=1
export DATABASE_URL=postgresql://USER:PASS@localhost:5432/maps_leads_finder_test
npm install
npm run migrate   # first apply
npm run migrate   # must skip all
npm test
# repeat concurrency-focused runs as needed
```

Validation of locks against a live cluster is **pending** until the deploy/test environment is available.
