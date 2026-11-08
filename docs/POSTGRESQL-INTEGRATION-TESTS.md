# Testes de integração PostgreSQL — Maps Leads Finder SaaS

**Estado:** unitários executados (44 pass). Testes PG **implementados**; execução/validação real **PENDENTE** (sem BD `*_test` + `ALLOW_DB_TESTS=1` neste ambiente).

## Matriz oficial A–H

| ID | Cenário | Ficheiro | Implementado | Executado | Validado PG real |
|----|---------|----------|--------------|-----------|------------------|
| A | Aquisição concorrente | `quotaHold.pg.test.js` | Sim | Não | **PENDENTE** |
| B | Isolamento multiutilizador | `quotaHold.pg.test.js` | Sim | Não | **PENDENTE** |
| C | Renovação × recuperação | `recoveryConcurrency.pg.test.js` | Sim | Não | **PENDENTE** |
| D | Persistência × recuperação (sucesso + falha) | `recoveryConcurrency.pg.test.js` | Sim | Não | **PENDENTE** |
| E | Dois jobs `runOnce` reais + extra lock manual | `recoveryConcurrency.pg.test.js` | Sim | Não | **PENDENTE** |
| F | Lease expirada | `quotaHold.pg.test.js` | Sim | Não | **PENDENTE** |
| G | Token substituído | `quotaHold.pg.test.js` | Sim | Não | **PENDENTE** |
| H | Idempotência da recuperação | `recoveryConcurrency.pg.test.js` | Sim | Não | **PENDENTE** |

### Notas D / E

* **D:** `recoverPromise` é sempre `await` no `finally` (sucesso e falha). Caminho de falha: `afterUserLock` lança após bloquear recover; TX reverte; recover prossegue; sem hang.
* **E:** duas `runOnce()` reais em paralelo; a segunda devolve `skipped: true` / `reason: 'lock_held'` enquanto a primeira mantém o advisory lock.

## Schema e guard

Migrations 008/009. Testes **sem** `ALTER TABLE`.  
`ALLOW_DB_TESTS=1`, `NODE_ENV=test`, BD `*_test`.

```bash
export NODE_ENV=test ALLOW_DB_TESTS=1
export TEST_DATABASE_URL='postgresql://…/maps_leads_finder_test'
npm run migrate
node --test tests/quotaHold.pg.test.js tests/recoveryConcurrency.pg.test.js
```

## Produção

Não usar BD Render; não migrar produção; não activar recovery job.
