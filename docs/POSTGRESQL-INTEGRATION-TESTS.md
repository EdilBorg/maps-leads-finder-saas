# Testes de integração PostgreSQL — Maps Leads Finder SaaS

Documento de referência permanente para validar concorrência, reservas gratuitas e recuperação de pesquisas abandonadas numa **base de dados isolada**.

**Estado actual:** testes unitários disponíveis e a passar; testes reais PostgreSQL de concorrência **ainda não validados** neste ambiente.

Não confunda mocks unitários com integração real. Não altere estados desta tabela para “PASSOU” sem execução efectiva numa BD `*_test`.

---

## 1. Situação actual

### Testes unitários (sempre seguros)

| Área | Ficheiros | Notas |
|------|-----------|--------|
| Quota / hold | `tests/quotaHold.test.js` | acquire, consume, renew, release, lockUserForUpdate |
| Recovery job | `tests/abandonedSearchRecovery.test.js` | advisory lock, unlock, destroy client |
| Shutdown / renovação | `tests/shutdown.and.renewal.test.js` | pool close, retry, sync errors |

Comando: `npm test`

### Testes de integração existentes

| Ficheiro | Conteúdo aproximado |
|----------|---------------------|
| `tests/quotaHold.pg.test.js` | Aquisição, consumo, renovação, libertação, paralelismo, isolamento, lease válida/expirada, token substituído |
| `tests/session.pg.test.js` | Sessões PostgreSQL (auth) |
| `tests/domain.model.test.js` / `domain.concurrency.test.js` | Modelo de domínio e concorrência de locks de tenant |

Estes ficheiros **só correm** quando o `testDbGuard` autoriza.

### Cenários de concorrência ainda pendentes de validação real

Ver secção 6 e tabela final.

---

## 2. Requisitos do ambiente futuro

- Node.js **≥ 20**
- PostgreSQL compatível (12+ recomendado)
- `npm install` concluído
- Pelo menos **duas conexões** simultâneas
- Base de dados **exclusiva para testes** (nunca produção / Render)
- Migrations **apenas** nessa base

---

## 3. Protecção (`testDbGuard` + `resolveConnection`)

Ficheiros: `tests/helpers/testDbGuard.js`, `src/db/connectionConfig.js`

Obrigatório:

1. `NODE_ENV` ≠ `production`
2. `ALLOW_DB_TESTS=1`
3. Conexão resolvida (mesma do pool) segura
4. Nome termina em `_test` **ou** igual a `TEST_DATABASE_NAME`
5. `DATABASE_URL` e `TEST_DATABASE_URL` não divergem se ambas existirem

| Ambiente | Comportamento |
|----------|----------------|
| production + `TEST_DATABASE_URL` | Erro |
| production + `ALLOW_DB_TESTS=1` | Erro |
| URLs divergentes | Erro |
| Não-prod + `TEST_DATABASE_URL` sem ALLOW | Erro |
| Não-prod + ALLOW + `TEST_DATABASE_URL` | Usa só TEST_DATABASE_URL |
| Caso contrário | DATABASE_URL ou PG* |

**Nunca** use DATABASE_URL de produção.

---

## 4. Preparação da BD de teste

1. Criar BD dedicada (ex.: `maps_leads_finder_test`).
2. Confirmar que não é produção.
3. Configurar:

```bash
export NODE_ENV=test
export ALLOW_DB_TESTS=1
export TEST_DATABASE_URL='postgresql://USER:PASS@HOST:5432/maps_leads_finder_test'
```

4. Migrations só nessa BD: `npm run migrate`
5. Verificar tabelas; correr integração simples; depois concorrência.

---

## 5. Execução

```bash
npm test                          # suite completa
node --test tests/quotaHold.pg.test.js   # após ALLOW_DB_TESTS=1 + BD segura
```

Scripts: `test` → `node --test tests/` ; `migrate` → `node scripts/migrate.js`.

---

## 6. Cenários A–H (estado PENDENTE até validação)

Ordem de locks: **users → searches**.

| ID | Cenário | Resultado esperado | Estado |
|----|---------|-------------------|--------|
| A | Aquisição concorrente (2 clients, mesmo user) | Um wins; outro FREE_SEARCH_IN_PROGRESS | PENDENTE |
| B | Isolamento multi-tenant | Ambos adquirem | PENDENTE |
| C | Renovação × recuperação | Lease válida não abandoned; sem deadlock | PENDENTE |
| D | Persistência × recuperação | Atomicidade; sem deadlock | PENDENTE |
| E | Dois jobs recovery | Advisory lock; unlock mesma sessão | PENDENTE |
| F | Lease expirada | Mark failed; hold libertado | PENDENTE |
| G | Token substituído | Token antigo não consome/liberta | PENDENTE |
| H | Idempotência recovery | Segunda execução inócua | PENDENTE |

---

## 7. Registo de validação futura

| Cenário | Estado | Data | Observações |
|---------|--------|------|-------------|
| Aquisição concorrente | PENDENTE | — | — |
| Isolamento entre utilizadores | PENDENTE | — | — |
| Renovação × recuperação | PENDENTE | — | — |
| Persistência × recuperação | PENDENTE | — | — |
| Dois jobs simultâneos | PENDENTE | — | — |
| Lease expirada | PENDENTE | — | — |
| Token substituído | PENDENTE | — | — |
| Idempotência | PENDENTE | — | — |

> **Não** alterar para PASSOU sem execução real numa BD PostgreSQL isolada.

---

## 8. Produção

Proibido: migrar/testar na BD Render de produção; activar recovery job sem validação; apontar variáveis de teste a produção.
