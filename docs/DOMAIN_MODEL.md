# Domain model (Etapa 5)

Migrations:

1. `001_auth.sql` — users, sessions, tokens  
2. `002_fix_session_oids.sql` — session compatibility  
3. `003_domain_model.sql` — domain tables  
4. `004_domain_integrity_fixes.sql` — child INSERT/UPDATE same-tenant checks  
5. `005_domain_update_integrity.sql` — parent UPDATE protection + row locks  
6. `006_domain_lock_ordering.sql` — transaction advisory locks for consistent parent-key order  

## Multi-tenant isolation

| Relation | Child INSERT/UPDATE | Parent UPDATE |
|----------|-------------------|---------------|
| payments → subscriptions | Advisory `sub:<id>` + lock subscription; same `user_id` | Cannot change `subscriptions.user_id` if payments reference it |
| saved_leads → searches | Advisory `search:<id>` + lock search; same `user_id` | Cannot change `searches.user_id` if leads/results reference it |
| search_results → searches | Composite FK `(search_id, user_id)` | Same as above for results |
| is_duplicate_of | Advisory `result:<id>` + same `search_id`/`user_id`; no self-ref | Cannot move a result that is target of `is_duplicate_of` |

Application code must still filter by `user_id` on every query.

## Concurrency strategy

**Global lock order (migration 006):** before row `FOR UPDATE` checks, triggers take a transaction-scoped advisory lock on the parent entity key:

- payments / subscriptions → `pg_advisory_xact_lock(hashtext('sub:' || subscription_id))`
- saved_leads / searches → `hashtext('search:' || search_id)`
- is_duplicate_of target → `hashtext('result:' || result_id)`

Both parent-owner changes and child reference checks acquire the **same** advisory key first, which serializes competing transactions and avoids the classic deadlock (child holds child-row lock waiting for parent, parent holds parent-row lock waiting for child).

Then:

1. **Child path:** `SELECT … FOR UPDATE` on the referenced parent before comparing owners.  
2. **Parent path:** `SELECT … FOR UPDATE` on dependents ordered by primary key (`ORDER BY id`) before rejecting owner/scope changes.  
3. **Deadlocks / serialization:** Residual deadlocks may still surface as `40P01` (`deadlock_detected`). Under stricter isolation, conflicts may appear as `40001` (`serialization_failure`). Retry the **entire** transaction only when the operation is safe to repeat. Do **not** treat `40001` as a deadlock code.  
4. **Isolation:** Default `READ COMMITTED` with advisory + row locks.  

Integration tests use two independent clients, `pg_backend_pid()`, and `pg_blocking_pids()`. If the expected block is not observed before timeout, the test **fails** (no silent catch).

## Migrations runner

`src/db/migrate.js` is the single source of truth (used by `scripts/migrate.js` and test helpers). It takes `pg_advisory_lock` for the whole run so concurrent processes cannot apply the same files twice. Failed migrations are rolled back and **not** recorded in `schema_migrations`.

## Retention vs snapshots

- Deleting a search **cascades** `search_results`.  
- Deleting a search sets `saved_leads.origin_search_id` to **NULL**; snapshot columns remain.

## api_providers secrets

- `config` / `rate_limits`: non-sensitive metadata only.  
- Credentials: environment variables or secrets manager only; never frontend or logs.

## Limitations

- Long duplicate cycles (A→B→A) are not fully blocked beyond self-reference.  
- Changing `searches.user_id` is forbidden when any results exist (even same-tenant).  
- Concurrent tests require a real PostgreSQL instance (`ALLOW_DB_TESTS=1`, database name ending in `_test`).
