# Fase 3 — Correções (quota, recuperação, persistência)

## recoverAbandonedSearches

**Problema:** usava só `started_at` antigo; pesquisas longas com lease renovada eram marcadas `failed`.

**Correção:** só recupera se **não** existir lease válida ligada à pesquisa (`hold_search_id`, token, `until > NOW()`, `used=FALSE`). Libertação do hold exige o mesmo token e lease já expirada — nunca um token mais recente.

## Recuperação automática

`abandonedSearchRecovery.js` + `ENABLE_ABANDONED_SEARCH_RECOVERY=1` + `pg_try_advisory_lock`.

## Migrations 008/009

Não executadas em produção nesta tarefa.

## Testes

- Unitários hold/recover: pass
- Integração PG (`quotaHold.pg.test.js`): skipped sem `ALLOW_DB_TESTS=1` + BD `*_test`
