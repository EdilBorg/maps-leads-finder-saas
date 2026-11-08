# Testes de integração PostgreSQL — Maps Leads Finder SaaS

**Estado:** unitários executados neste ambiente. Testes PG **implementados**; execução/validação real **PENDENTE** (sem BD `*_test` + `ALLOW_DB_TESTS=1`).

## Matriz oficial A–H (única)

| ID | Cenário | Comportamento | Ficheiro |
|----|---------|---------------|----------|
| A | Aquisição concorrente | Duas aquisições simultâneas do mesmo user: só uma obtém a reserva | `quotaHold.pg.test.js` |
| B | Isolamento multiutilizador | Dois users adquirem independentemente | `quotaHold.pg.test.js` |
| C | Renovação × recuperação | Lease renovada sob lock protege search `running` | `recoveryConcurrency.pg.test.js` |
| D | Persistência × recuperação | `runAndPersist` real vs recover; sem deadlock; resultados + quota | `recoveryConcurrency.pg.test.js` |
| E | Dois jobs de recuperação | Advisory lock: segundo job `skipped` | `recoveryConcurrency.pg.test.js` |
| F | Lease expirada | Reserva expirada recuperável; token antigo não consome | `quotaHold.pg.test.js` |
| G | Token substituído | Token antigo não renova/consome/liberta a reserva nova | `quotaHold.pg.test.js` |
| H | Idempotência da recuperação | 2.ª recover: snapshot idêntico; target deixa de ser elegível | `recoveryConcurrency.pg.test.js` |

Testes `extra:` cobrem primeira reserva, consume, release, token estrangeiro, renew, etc.

| ID | Implementado | Executado | Validado PG real |
|----|--------------|-----------|------------------|
| A–H | Sim | Não | **PENDENTE** |

## Schema

Migrations `008` e `009`. **Os testes não executam ALTER TABLE / CREATE TABLE / ADD COLUMN.**

## Guard e execução

```bash
export NODE_ENV=test ALLOW_DB_TESTS=1
export TEST_DATABASE_URL='postgresql://…/maps_leads_finder_test'
npm run migrate
node --test tests/quotaHold.pg.test.js tests/recoveryConcurrency.pg.test.js
```

## Produção

Não usar BD Render; não migrar produção; não activar recovery job.
