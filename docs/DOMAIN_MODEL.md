# Domain model (Etapa 5)

Migrations:

- `001_auth.sql` — users, sessions, tokens
- `002_fix_session_oids.sql` — session table compatibility
- `003_domain_model.sql` — domain tables
- `004_domain_integrity_fixes.sql` — multi-tenant integrity (payments, saved_leads, duplicates)

## Multi-tenant isolation

| Table | Rule |
|-------|------|
| `searches` | `user_id` → `users.id` |
| `search_results` | Composite FK `(search_id, user_id)` → `searches(id, user_id)` |
| `search_results.is_duplicate_of` | Trigger: same `search_id` **and** `user_id`; no self-reference |
| `saved_leads` | `user_id` → `users`; `origin_search_id` must match same user (trigger); `ON DELETE SET NULL` on origin only |
| `payments` | `user_id` → `users`; `subscription_id` must match same user (trigger); nullable subscription |
| `subscriptions` | `user_id` → `users`; `UNIQUE (id, user_id)` |

Triggers are used where a composite FK with `ON DELETE SET NULL` would also null `user_id`.

Application services must still filter by `user_id` on every query.

## Retention vs snapshots

- `search_results` cascade when a search is deleted (30-day retention jobs).
- `saved_leads` snapshots **survive** search deletion (`origin_search_id` becomes NULL).

## api_providers secrets policy

- `config` and `rate_limits` store **non-sensitive** metadata only (base URLs, feature flags, numeric limits).
- API keys, tokens and passwords **must not** be stored in `config`.
- Credentials live in environment variables (or a future secrets manager), loaded only in server-side provider adapters.
- Adapters must never send secrets to the frontend or write them to application logs.
- No real providers are integrated in this stage.

## Not implemented in this stage

Quota reservation runtime, search engine, payment gateways, admin UI.
