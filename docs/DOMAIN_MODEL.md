# Domain model (Etapa 5)

Migrations:

1. `001_auth.sql` — users, sessions, tokens  
2. `002_fix_session_oids.sql` — session compatibility  
3. `003_domain_model.sql` — domain tables  
4. `004_domain_integrity_fixes.sql` — child INSERT/UPDATE same-tenant checks  
5. `005_domain_update_integrity.sql` — parent UPDATE protection + row locks for concurrency  

## Multi-tenant isolation

| Relation | Child INSERT/UPDATE | Parent UPDATE |
|----------|-------------------|---------------|
| payments → subscriptions | Trigger locks subscription `FOR UPDATE`; requires same `user_id` | Cannot change `subscriptions.user_id` if payments reference it (locks payments by `id`) |
| saved_leads → searches | Trigger locks search `FOR UPDATE`; same `user_id` | Cannot change `searches.user_id` if leads/results reference it |
| search_results → searches | Composite FK `(search_id, user_id)` | Same as above for results |
| is_duplicate_of | Same `search_id` + `user_id`; no self-ref | Cannot move a result that is target of `is_duplicate_of` |

Application code must still filter by `user_id` on every query.

## Concurrency strategy

1. **Child path:** `SELECT … FOR UPDATE` on the referenced parent before comparing owners.  
2. **Parent path:** `SELECT … FOR UPDATE` on dependents ordered by primary key (`ORDER BY id`) before rejecting owner/scope changes.  
3. **Lock order:** Prefer locking the parent (by PK) first, then children ordered by `id`, to reduce deadlock cycles.  
4. **Deadlocks / serialization:** Still possible under complex multi-row updates. PostgreSQL may abort a transaction with `40P01` (`deadlock_detected`) or, under stricter isolation, `40001` (`serialization_failure`). Both require retrying the **entire** transaction when the operation is idempotent/safe to repeat. Do **not** treat `40001` as a deadlock code.  
5. **Isolation:** Default `READ COMMITTED` is sufficient with these row locks; does not require `SERIALIZABLE`.

Integration tests use two independent clients, `pg_backend_pid()`, and `pg_blocking_pids()` to wait until a session is actually blocked before completing the competing transaction (no reliance on arbitrary sleeps alone).

## Retention vs snapshots

- Deleting a search **cascades** `search_results`.  
- Deleting a search sets `saved_leads.origin_search_id` to **NULL**; snapshot columns remain.

## api_providers secrets

- `config` / `rate_limits`: non-sensitive metadata only.  
- Credentials: environment variables or secrets manager only; never frontend or logs.

## Limitations

- Long duplicate cycles (A→B→A) are not fully blocked beyond self-reference.  
- Changing `searches.user_id` is forbidden when any results exist (even same-tenant); reassign via application workflow if ever needed.  
- Concurrent tests require a real PostgreSQL instance (`ALLOW_DB_TESTS=1`, database name ending in `_test`).
