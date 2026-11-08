# Fase 3 — Correções (locks, bind, job, shutdown)

## Estratégia global de locks (anti-deadlock)

**Ordem obrigatória:** `users` → `searches` em qualquer transação que toque nas duas tabelas.

| Caminho | Ordem |
|---------|--------|
| `runAndPersist` fase 1 | acquire users → INSERT searches → bind users |
| `runAndPersist` fase 2 (erro motor) | `lockUserForUpdate` → UPDATE searches → release users |
| `runAndPersist` fase 3 | `lockUserForUpdate` → UPDATE searches → INSERT results → consume/release users |
| `recoverAbandonedSearches` | `SELECT users FOR UPDATE ORDER BY id` → UPDATE searches → clear holds users |

## bindHoldToSearch

Se devolver `false`: ROLLBACK, `releaseFreeSearchHold` do token próprio, erro `HOLD_BIND_FAILED`.

## Advisory unlock

- Verifica `pg_advisory_unlock` → `ok === true`.
- Se `false` ou excepção: `client.release(true)` (destrói a sessão).

## Shutdown

`stopAbandonedSearchRecovery()` → `waitForIdle(7000)` → `closePool()`.

## Migrations 008/009

Não executadas em produção. Job não activado em produção.

## Testes

| Suite | Resultado neste ambiente |
|-------|--------------------------|
| Unitários hold + resolveDbClient + lockUser + job | **pass** (24) |
| Integração PG (`quotaHold.pg.test.js`) | **skipped** (sem BD `*_test`) |
