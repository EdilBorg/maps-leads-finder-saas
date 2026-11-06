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
| 5 — Modelo de dados e isolamento multi-tenant | Implementada (schema + integridade INSERT/UPDATE; aguarda validação) |
| 6+ | **Não iniciada** |

### Etapa 5 — domínio

Tabelas: `plans`, `subscriptions`, `payments`, `searches`, `search_results`, `saved_leads`, `api_providers`, `audit_logs`, `system_settings` (reutiliza `users`).

Isolamento (INSERT, UPDATE e concorrência):

- Resultados e pesquisas: FK composta `(search_id, user_id)`.
- Pagamentos / leads / duplicados: triggers com `FOR UPDATE` + bloqueio de mudança de proprietário no registo pai.
- Resultados expiram com a pesquisa (retenção 30 dias); **snapshots** em `saved_leads` sobrevivem.

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

### Testes de integração PostgreSQL

```bash
export NODE_ENV=test
export ALLOW_DB_TESTS=1
export DATABASE_URL=postgresql://USER:PASS@localhost:5432/maps_leads_finder_test
npm run migrate
npm test
```

Sem opt-in e BD `*_test`, as suites PG ficam em **SKIP**.

### Limitações

- Em concorrência, o PostgreSQL pode abortar uma transação com `40P01` (`deadlock_detected`) ou, sob isolamento mais estrito, `40001` (`serialization_failure`). Em ambos os casos, a aplicação deve repetir a **transação inteira** se a operação for segura para retry. **`40001` não é código de deadlock.**
- Rate limit em memória se a BD cair (não distribuído).
- Credenciais de fornecedores: apenas env / secrets manager — nunca em `api_providers.config`.
- `TRUST_PROXY_HOPS` deve refletir a topologia real em produção.
