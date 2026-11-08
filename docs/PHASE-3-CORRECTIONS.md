# Fase 3 — Correções (quota, recuperação, job, concorrência)

## Problema 1 — Pool vs PoolClient

**Causa:** `recoverAbandonedSearches` usava `db.query && !db.release` e, ao receber um `PoolClient` (tem `release`), tentava `db.connect()`, o que falha. O job capturava o erro com `.catch(() => {})`.

**Correção:** `resolveDbClient()` distingue explicitamente:
- Pool: `connect` presente, `release` ausente → `connect()`, owns release
- PoolClient: `release` presente, `connect` ausente → usa o cliente, não liberta
- mock só com `query` → tratado como cliente do chamador

## Problema 2 — Concorrência renew × recover

**Estratégia:**
1. Dentro da transação de recover: `SELECT ... FROM users ... ORDER BY u.id FOR UPDATE OF u` (ordem estável).
2. Depois `UPDATE searches ... FROM users` com a condição `NOT (lease válida ligada à pesquisa)`.
3. Libertação do hold só com token exacto + `until <= NOW()` (ou NULL).

`renewFreeSearchHold` actualiza a mesma linha `users` com `WHERE token + until > NOW()`. Se recover já bloqueou a linha, renew espera; após COMMIT, ou a lease foi limpa (renew falha) ou renew estendeu antes e recover não marca a pesquisa.

## Problema 3 — Job

- Advisory lock e unlock na **mesma** sessão.
- Guard in-process (`running`) evita sobreposição de ticks.
- Logs estruturados; falhas não são engolidas em silêncio para quem chama `runOnce`.
- `ENABLE_ABANDONED_SEARCH_RECOVERY=1` (não activar em produção nesta tarefa).

## Migrations

008/009: **não executadas em produção**.

## Testes

| Suite | Tipo | PG real | Resultado neste ambiente |
|-------|------|---------|--------------------------|
| quotaHold.test.js | unitário | não | **pass** |
| abandonedSearchRecovery.test.js | unitário | não | **pass** |
| quotaHold.pg.test.js | integração | sim | **skipped** (sem BD `*_test`) |

## Activação futura

1. Aplicar migrations 008 e 009 no Render.
2. Definir `ENABLE_ABANDONED_SEARCH_RECOVERY=1`.
3. Opcional: `ABANDONED_SEARCH_RECOVERY_INTERVAL_MS`.
