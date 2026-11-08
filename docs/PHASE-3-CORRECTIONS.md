# Fase 3 — Correções (shutdown, renovação, locks, testes)

## Shutdown

- `poolClosed: true` apenas se `closePool()` concluir sem erro.
- Falha de close ou job activo → retryable; estado desbloqueado.
- `exit(0)` só com `poolClosed: true`.

## Renovação

- Erros síncronos de `getPoolFn`/`connect` tratados.
- Logs sem token; `inFlight` no finally.

## PostgreSQL

Ver `docs/POSTGRESQL-INTEGRATION-TESTS.md`. Concorrência real: PENDENTE.

## Produção

Sem migrations, job ou alterações no Render.
