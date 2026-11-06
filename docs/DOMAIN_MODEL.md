# Domain model (Etapa 5)

Incremental migration: `migrations/003_domain_model.sql`.

## Multi-tenant isolation

| Table | Ownership |
|-------|-----------|
| `searches` | `user_id` → `users.id` |
| `search_results` | Composite FK `(search_id, user_id)` → `searches(id, user_id)` — cannot attach results to another user's search |
| `saved_leads` | `user_id` → `users.id`; optional `origin_search_id` with `ON DELETE SET NULL` |
| `subscriptions` / `payments` | `user_id` → `users.id` |

Application services must still filter by `user_id` on every query; constraints are the safety net.

## Retention vs snapshots

- `search_results` cascade when a search is deleted (supports 30-day retention jobs).
- `saved_leads` are independent snapshots and **survive** search deletion.

## Not implemented in this stage

Quota reservation logic, search engine, payment gateways, admin UI.
