# Fase 3 — Correções

## Shutdown

- `poolClosed: true` somente após `closePool()` bem-sucedido.
- `closePool` ausente → `poolClosed: false`, `closeError: true`, `reason: CLOSE_POOL_MISSING`, `retryable: true`.
- Timeout do job ou falha de close → estado desbloqueado para retry.
- `exit(0)` apenas com `poolClosed: true`.

## Renovação

- Erros síncronos/assíncronos tratados; token nunca nos logs.

## Testes PG

Ver `docs/POSTGRESQL-INTEGRATION-TESTS.md`. Cenários C/D/E/H em `tests/recoveryConcurrency.pg.test.js`.

## Produção

Sem migrations, job ou alterações no Render nesta tarefa.
