# Maps Leads Finder SaaS

Plataforma SaaS multiutilizador para pesquisa e gestão de leads comerciais a partir de múltiplos fornecedores de dados geográficos e comerciais.

**Repositório oficial:** https://github.com/EdilBorg/maps-leads-finder-saas  
**Especificação:** [SPECIFICATION.md](./SPECIFICATION.md)  
**Referência visual:** [DESIGN.md](./DESIGN.md)  
**Modelo de dados:** [docs/DOMAIN_MODEL.md](./docs/DOMAIN_MODEL.md)

---

## Estado do projeto

| Etapa | Estado |
|-------|--------|
| 1 — Especificação | Concluída |
| 2 — Estrutura inicial (Express, health, config) | Concluída |
| 3 — Sistema visual e interface | Concluída |
| 4 — Autenticação e segurança | Concluída |
| 5 — Modelo de dados e isolamento multi-tenant | Implementada (schema + integridade; **validação PostgreSQL pendente**) |
| 6+ | **Não iniciada** |

### Etapa 5 — domínio

Tabelas: `plans`, `subscriptions`, `payments`, `searches`, `search_results`, `saved_leads`, `api_providers`, `audit_logs`, `system_settings` (reutiliza `users`).

Isolamento multi-tenant via FKs compostas, triggers e **locks de aplicação** (`src/db/tenantLocks.js` / `lock_tenant_*`). Detalhe em `docs/DOMAIN_MODEL.md`.

### Ainda não implementado

Motor de pesquisa, quotas em runtime, pagamentos reais, admin, integrações com fornecedores.

---

## Requisitos

- Node.js **20+**
- PostgreSQL **12+**

---

## Instalação

```bash
git clone https://github.com/EdilBorg/maps-leads-finder-saas.git
cd maps-leads-finder-saas
cp .env.example .env
npm install
npm run migrate
npm run dev
```

Scripts: `npm run dev` | `npm start` | `npm test` | `npm run migrate`

### Migrations

1. `001_auth.sql`
2. `002_fix_session_oids.sql`
3. `003_domain_model.sql`
4. `004_domain_integrity_fixes.sql`
5. `005_domain_update_integrity.sql` — integridade em UPDATE + locks de concorrência
6. `006_domain_lock_ordering.sql` — advisory locks nos triggers (defense in depth)
7. `007_domain_tenant_lock_helpers.sql` — helpers SQL + estratégia de locks na aplicação

### Testes de integração PostgreSQL (posterior)

```bash
export NODE_ENV=test
export ALLOW_DB_TESTS=1
export DATABASE_URL=postgresql://USER:PASS@localhost:5432/maps_leads_finder_test
npm run migrate
npm run migrate
npm test
```

Sem opt-in e BD `*_test`, as suites PG ficam em **SKIP**. A execução real fica para o ambiente de testes/deploy.

### Locks multi-tenant (aplicação)

Antes de mutações em payments/subscriptions/searches/leads/results, a aplicação deve adquirir locks de transação (`src/db/tenantLocks.js` ou `lock_tenant_*` no SQL). Ver `docs/DOMAIN_MODEL.md`.

### Limitações

- Em concorrência sem pre-lock de aplicação, pode ocorrer `40P01` (`deadlock_detected`). `40001` é `serialization_failure`, não deadlock. Retry só se a operação for segura.
- Rate limit em memória se a BD cair (não distribuído).
- Credenciais de fornecedores: apenas env / secrets manager — nunca em `api_providers.config`.
- `TRUST_PROXY_HOPS` deve refletir a topologia real em produção.
