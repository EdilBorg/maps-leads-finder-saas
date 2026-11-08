# Fase 3 — Correções

## Shutdown
`poolClosed` só após close bem-sucedido; ausência = CLOSE_POOL_MISSING + retryable.

## PG concurrency
- pgLockWait.js (pg_blocking_pids)
- C/D/E/H oficiais; D usa runAndPersist real
- Matriz A–H alinhada; sem ALTER TABLE nos testes

## Produção
Sem alterações Render/migrations/job.
