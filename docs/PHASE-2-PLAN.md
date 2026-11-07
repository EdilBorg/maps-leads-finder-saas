# Fase 2 — Base de dados PostgreSQL (registo histórico)

Documento de registo da implementação da persistência PostgreSQL no Maps Leads Finder SaaS.
**Não** é um plano para reconstruir a base de dados.

## Objetivo e âmbito

- Persistência multiutilizador com isolamento por `user_id`.
- Tabelas de autenticação (Etapa 4) e modelo de domínio (Etapa 5).
- Migrations versionadas e idempotentes (`schema_migrations`).
- Sessões em PostgreSQL (`connect-pg-simple`).
- Runner partilhado (`src/db/migrate.js`) com advisory lock de sessão.

## Configuração

- Variável principal: `DATABASE_URL` (produção Render e desenvolvimento).
- Alternativas: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`.
- Testes: `ALLOW_DB_TESTS=1` e base identificada como teste (`*_test` ou `TEST_DATABASE_NAME`).
- Produção: `TEST_DATABASE_URL` rejeitado quando `NODE_ENV=production`.

## Migrations (001–007)

| Ficheiro | Conteúdo |
|----------|----------|
| `001_auth.sql` | users, session, tokens, login_attempts, rate_limit_buckets |
| `002_fix_session_oids.sql` | compatibilidade session sem OIDS |
| `003_domain_model.sql` | plans, subscriptions, payments, searches, search_results, saved_leads, api_providers, audit_logs, system_settings |
| `004_domain_integrity_fixes.sql` | triggers multi-tenant em INSERT/UPDATE de filhos |
| `005_domain_update_integrity.sql` | proteção em UPDATE de pais |
| `006_domain_lock_ordering.sql` | advisory locks nos triggers (defense in depth) |
| `007_domain_tenant_lock_helpers.sql` | helpers SQL de lock + notas de estratégia na app |

## Isolamento multi-tenant

- FK composta `(search_id, user_id)` em `search_results`.
- Triggers que impedem referências cross-tenant.
- `saved_leads` como snapshots (`ON DELETE SET NULL` na origem).
- Helpers de aplicação: `src/db/tenantLocks.js` (`lockReferenceChange`, `TENANT_LOCK_RETRY`).

## Ambiente de produção (Render)

- `DATABASE_URL` fornecido pelo serviço PostgreSQL do Render.
- `SESSION_SECRET` obrigatório.
- `TRUST_PROXY_HOPS` deve refletir a topologia real (tipicamente 1 atrás do proxy Render).
- Migrations: `npm run migrate` no deploy / release command.

## Testes

| Tipo | Estado |
|------|--------|
| Unitários (crypto, rate limit keys, tenantLocks, migrate runner, searchEngine) | Executáveis sem PostgreSQL |
| Integração PostgreSQL (domain model, concurrency, auth session, rate limit concurrency) | **Pendentes** até ambiente com `ALLOW_DB_TESTS=1` e BD `*_test` |

## Problemas e soluções (histórico resumido)

- Isolamento de BD de testes vs produção → `connectionConfig` + `testDbGuard`.
- Locks de sessão no migration runner → destroy client se unlock falhar.
- Deadlocks multi-tenant → locks de aplicação ordenados + triggers.
- `TEST_DATABASE_URL` em produção → rejeição explícita.

## Fora de âmbito desta fase

- Motor de pesquisa e fornecedores (Fase 3).
- Billing e quotas pagas.
- Painel administrativo.
