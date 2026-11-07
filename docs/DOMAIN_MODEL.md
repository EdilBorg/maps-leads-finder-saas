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

`pg_advisory_xact_lock` is **transaction-scoped**. Use only after `BEGIN`. Outside a transaction block the lock may be released at statement end. `COMMIT`/`ROLLBACK` release xact locks.

## FK change protocol

**Do not** `SELECT … FOR UPDATE` before advisory locks.

1. `BEGIN`
2. `stabilizeAndLockReferenceChange(client, kind, readCurrent, newId)`
   - reads FK once
   - acquires locks for **observed + new** once (global order)
   - re-reads; if equal → return
   - if changed → **`TENANT_LOCK_RETRY`** (no extra locks) → `ROLLBACK` and **restart the whole transaction**
3. `UPDATE … SET fk = $new WHERE id = $id AND fk IS NOT DISTINCT FROM $observed`
4. `COMMIT`

Same for `'sub'`, `'search'`, `'result'`.

## Migration runner

Session `pg_advisory_lock`. Acquire failure → `client.release(true)`. Unlock failure → destroy. Confirmed unlock → return to pool. Never double-release.

## Error codes

| Code | Meaning |
|------|---------|
| `23514` | check_violation |
| `40P01` | deadlock — retry whole xact if idempotent |
| `40001` | serialization_failure |
| `TENANT_LOCK_RETRY` | FK changed underfoot — ROLLBACK + full retry |

## Limitations

PostgreSQL integration tests: **pending**.

```bash
export NODE_ENV=test ALLOW_DB_TESTS=1
export DATABASE_URL=postgresql://USER:PASS@localhost:5432/maps_leads_finder_test
npm run migrate && npm run migrate && npm test
```
