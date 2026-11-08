# Testes de integração PostgreSQL — Maps Leads Finder SaaS

Referência permanente para validar holds, recuperação e concorrência numa **base isolada**.

**Estado actual**

| Tipo | Estado |
|------|--------|
| Testes unitários | Implementados e executados neste ambiente |
| Testes PG (ficheiros) | Implementados; **execução real pendente** sem BD `*_test` |
| Validação de concorrência A–H | **Não validada** até corrida real com `ALLOW_DB_TESTS=1` |

Não marcar cenários como PASSOU sem execução efectiva.

---

## 1. Ficheiros de teste

| Ficheiro | Conteúdo |
|----------|----------|
| `tests/quotaHold.test.js` | Unitário: acquire/consume/renew/release, lockUserForUpdate |
| `tests/abandonedSearchRecovery.test.js` | Unitário: job, advisory unlock/destroy |
| `tests/shutdown.and.renewal.test.js` | Unitário: shutdown + renovação |
| `tests/quotaHold.pg.test.js` | Integração: A, B, F, G (e operações de hold) |
| `tests/recoveryConcurrency.pg.test.js` | Integração: **C, D, E, H** (concorrência real com 2 clients) |

Todos os `*.pg.test.js` usam `shouldRunDbIntegration()` / `assertSafeTestDatabase()`.

---

## 2. Pré-requisitos

- Node.js ≥ 20
- PostgreSQL 12+
- `npm install`
- BD exclusiva (nome `*_test` ou `TEST_DATABASE_NAME`)
- Migrations 001–009 aplicadas **só** nessa BD
- ≥ 2 conexões simultâneas

---

## 3. Protecção (`testDbGuard` + `resolveConnection`)

Obrigatório:

1. `NODE_ENV` ≠ `production`
2. `ALLOW_DB_TESTS=1`
3. Conexão resolvida = a do pool
4. Nome termina em `_test` **ou** igual a `TEST_DATABASE_NAME`
5. Sem divergência `DATABASE_URL` vs `TEST_DATABASE_URL`

Em produção: `TEST_DATABASE_URL` e `ALLOW_DB_TESTS=1` são rejeitados.

---

## 4. Preparação

```bash
export NODE_ENV=test
export ALLOW_DB_TESTS=1
export TEST_DATABASE_URL='postgresql://USER:PASS@HOST:5432/maps_leads_finder_test'

npm run migrate   # apenas na BD de teste
npm test
# ou:
node --test tests/quotaHold.pg.test.js tests/recoveryConcurrency.pg.test.js
```

Schema de holds: migrations `008_free_search_hold.sql` e `009_free_search_hold_search_id.sql` (sem `ALTER TABLE` ad-hoc nos testes).

Limpeza: fixtures criam emails `*_@test.local` e apagam `users` / `searches` / `search_results` no `finally`.

---

## 5. Cenários A–H

Ordem de locks: **users → searches**.

| ID | Nome | Ficheiro | Implementado | Executado aqui | Validado PG real |
|----|------|----------|--------------|----------------|------------------|
| A | Aquisição concorrente mesmo user | `quotaHold.pg.test.js` | Sim | Não | **PENDENTE** |
| B | Isolamento entre utilizadores | `quotaHold.pg.test.js` | Sim | Não | **PENDENTE** |
| C | Renovação × recuperação | `recoveryConcurrency.pg.test.js` | Sim | Não | **PENDENTE** |
| D | Persistência (lock user) × recuperação | `recoveryConcurrency.pg.test.js` | Sim | Não | **PENDENTE** |
| E | Dois jobs / advisory lock | `recoveryConcurrency.pg.test.js` | Sim | Não | **PENDENTE** |
| F | Lease expirada | `quotaHold.pg.test.js` | Sim | Não | **PENDENTE** |
| G | Token substituído | `quotaHold.pg.test.js` | Sim | Não | **PENDENTE** |
| H | Idempotência da recuperação | `recoveryConcurrency.pg.test.js` | Sim | Não | **PENDENTE** |

### Detalhe C–H

**C** — Client1: `BEGIN` + `lockUserForUpdate` + `renewFreeSearchHold` + `COMMIT`. Client2: `recoverAbandonedSearches` (bloqueia no user). Esperado: search `running`, lease válida.

**D** — Mesmo padrão com `UPDATE searches` sob o lock do user. Esperado: sem deadlock; search não `failed`; update persistido.

**E** — Sessão1 segura `pg_try_advisory_lock(87003145)`; `runOnce` noutra conexão → `skipped: lock_held`; unlock; re-aquisição possível.

**H** — Search antiga + hold expirado; recover ×2; status `failed` estável; sem re-transições indevidas.

---

## 6. Registo de validação futura

| Cenário | Estado | Data | Observações |
|---------|--------|------|-------------|
| A Aquisição concorrente | PENDENTE | — | — |
| B Isolamento multi-tenant | PENDENTE | — | — |
| C Renovação × recuperação | PENDENTE | — | — |
| D Persistência × recuperação | PENDENTE | — | — |
| E Dois jobs simultâneos | PENDENTE | — | — |
| F Lease expirada | PENDENTE | — | — |
| G Token substituído | PENDENTE | — | — |
| H Idempotência | PENDENTE | — | — |

> Não alterar para PASSOU sem execução real numa BD PostgreSQL isolada.

---

## 7. Produção

Proibido: testar ou migrar a BD Render de produção; activar `ENABLE_ABANDONED_SEARCH_RECOVERY` sem validação; usar `DATABASE_URL` de produção nestes testes.
