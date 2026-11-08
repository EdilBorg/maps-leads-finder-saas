# Testes de integração PostgreSQL — Maps Leads Finder SaaS

**Estado actual:** testes unitários executados neste ambiente; testes PG **implementados**, execução/validação real **PENDENTE** (sem BD `*_test` + `ALLOW_DB_TESTS=1`).

## Matriz oficial A–H

| ID | Cenário | Ficheiro / teste | Implementado | Executado | Validado PG real |
|----|---------|------------------|--------------|-----------|------------------|
| A | Aquisição concorrente (mesmo user) | `quotaHold.pg.test.js` — `A [official]` | Sim | Não | **PENDENTE** |
| B | Isolamento multiutilizador | `quotaHold.pg.test.js` — `B [official]` | Sim | Não | **PENDENTE** |
| C | Renovação × recuperação | `recoveryConcurrency.pg.test.js` — `C [official]` | Sim | Não | **PENDENTE** |
| D | Persistência (`runAndPersist`) × recuperação | `recoveryConcurrency.pg.test.js` — `D [official]` | Sim | Não | **PENDENTE** |
| E | Dois jobs / advisory lock | `recoveryConcurrency.pg.test.js` — `E [official]` | Sim | Não | **PENDENTE** |
| F | Lease expirada | `quotaHold.pg.test.js` — `F [official]` | Sim | Não | **PENDENTE** |
| G | Token substituído | `quotaHold.pg.test.js` — `G [official]` | Sim | Não | **PENDENTE** |
| H | Idempotência da recuperação | `recoveryConcurrency.pg.test.js` — `H [official]` | Sim | Não | **PENDENTE** |

Testes `extra:` cobrem primeira reserva, consume, release, token estrangeiro, renew, etc.

## Sincronização C/D

`tests/helpers/pgLockWait.js`: `waitUntilBlockedBy` via `pg_blocking_pids` (timeout 8s).

## Cenário D

`runAndPersist` com `executeSearchFn` + `afterUserLock` (sem APIs externas).

## Schema

Migrations 008/009. Testes sem `ALTER TABLE` ad-hoc.

## Guard e execução

```bash
export NODE_ENV=test ALLOW_DB_TESTS=1
export TEST_DATABASE_URL='postgresql://…/maps_leads_finder_test'
npm run migrate
node --test tests/quotaHold.pg.test.js tests/recoveryConcurrency.pg.test.js
```

## Produção

Não usar BD Render; não activar recovery job; não migrar produção.
