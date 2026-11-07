# Maps Leads Finder SaaS

**Repositório:** https://github.com/EdilBorg/maps-leads-finder-saas  
**Especificação:** [SPECIFICATION.md](./SPECIFICATION.md)  
**Design:** [DESIGN.md](./DESIGN.md)  
**Modelo de dados:** [docs/DOMAIN_MODEL.md](./docs/DOMAIN_MODEL.md)

## Estado

| Etapa | Estado |
|-------|--------|
| 1–4 | Concluídas |
| 5 — Modelo de dados / multi-tenant | Implementada; **validação PostgreSQL pendente** |
| 6+ | **Não iniciada** |

## Locks multi-tenant

`src/db/tenantLocks.js` / `lock_tenant_*`. Alterações de FK: `stabilizeAndLockReferenceChange`. Se a FK mudar sob concorrência → `TENANT_LOCK_RETRY` (ROLLBACK + nova transação completa). Ver `docs/DOMAIN_MODEL.md`.

## Migrations

001–007. Runner: `src/db/migrate.js` (advisory session lock; destroy client se unlock falhar).

## Testes PostgreSQL (posterior)

```bash
export NODE_ENV=test ALLOW_DB_TESTS=1
export DATABASE_URL=postgresql://USER:PASS@localhost:5432/maps_leads_finder_test
npm install && npm run migrate && npm run migrate && npm test
```
