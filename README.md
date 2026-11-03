# Maps Leads Finder SaaS

Plataforma SaaS multiutilizador para pesquisa e gestão de leads comerciais a partir de múltiplos fornecedores de dados geográficos e comerciais.

**Repositório oficial:** https://github.com/EdilBorg/maps-leads-finder-saas  
**Especificação:** [SPECIFICATION.md](./SPECIFICATION.md)  
**Referência visual:** [DESIGN.md](./DESIGN.md)

---

## Estado do projeto

| Etapa | Estado |
|-------|--------|
| 1 — Especificação | Concluída |
| 2 — Estrutura inicial (Express, health, config) | Concluída |
| 3 — Sistema visual e interface (DESIGN.md) | Concluída |
| 4 — Autenticação e segurança | Implementação concluída; **aguarda validação final dos testes** |
| 5 — Modelo de dados do domínio | **Não iniciada** |

### Etapa 4 — o que está implementado

- Registo, login, logout
- Verificação de email e recuperação / redefinição de palavra-passe
- Hashing **Argon2id**
- Sessões em PostgreSQL (`express-session` + `connect-pg-simple`)
- Proteção **CSRF** (token de sessão + cabeçalho `X-CSRF-Token`)
- Rate limiting atómico em PostgreSQL (`rate_limit_buckets`), com fallback em memória se a BD falhar
- `req.ip` como única fonte de IP; `TRUST_PROXY_HOPS` (omissão **0**)
- Páginas: login, registo, verificar email, recuperar / redefinir palavra-passe

### Ainda não implementado (Etapa 5+)

- Schema completo de pesquisas, leads, quotas e planos
- Motor de pesquisa e integração com fornecedores
- Pagamentos e painel administrativo
- Persistência real de histórico de pesquisas / leads (UI ainda em modo demo)

---

## Requisitos

- Node.js **20+**
- PostgreSQL **12+** (obrigatório para autenticação e sessões)

---

## Instalação local

```bash
git clone https://github.com/EdilBorg/maps-leads-finder-saas.git
cd maps-leads-finder-saas
cp .env.example .env
```

Editar `.env` no mínimo:

| Variável | Notas |
|----------|--------|
| `SESSION_SECRET` | Segredo forte (≥ 16 caracteres); obrigatório em produção |
| `DATABASE_URL` | PostgreSQL da aplicação |
| `TRUST_PROXY_HOPS` | **0** em desenvolvimento. Em produção, definir só depois de validar quantos proxies confiáveis existem à frente da app (ex. Abasthan). Valor errado compromete `req.ip`. |
| `SMTP_*` | Opcional em desenvolvimento (emails registados no log) |

```bash
npm install
npm run migrate
npm run dev
```

Scripts disponíveis em `package.json`:

| Script | Comando |
|--------|---------|
| `npm run dev` | `node --watch src/server.js` |
| `npm start` | `node src/server.js` |
| `npm test` | `node --test tests/` |
| `npm run migrate` | `node scripts/migrate.js` |

Servidor: `http://localhost:3000`

---

## Migrations

```bash
npm run migrate
```

- `migrations/001_auth.sql` — users, session, tokens, login_attempts, rate_limit_buckets (sem `OIDS`)
- `migrations/002_fix_session_oids.sql` — correção idempotente se o `CREATE session` antigo falhou

Não executar migrations de teste sobre bases de produção (ver secção de testes).

---

## Testes

### Testes sem PostgreSQL

```bash
npm test
```

Correm sempre (quando o ambiente permite instalar dependências): CSRF, crypto, health, migration SQL shape, testDbGuard, IP com `TRUST_PROXY_HOPS=0`.

### Testes de integração com PostgreSQL

Requerem **confirmação explícita** — a presença de `DATABASE_URL` **não** chega.

1. Criar uma base **exclusiva** de testes, por exemplo:

```sql
CREATE DATABASE maps_leads_finder_test;
```

2. Configurar o ambiente:

```bash
export NODE_ENV=test
export ALLOW_DB_TESTS=1
export DATABASE_URL=postgresql://USER:PASS@localhost:5432/maps_leads_finder_test
# Opcional se o nome não terminar em _test:
# export TEST_DATABASE_NAME=maps_leads_finder_test
npm run migrate
npm test
```

O guard (`tests/helpers/testDbGuard.js`) **rejeita**:

- `NODE_ENV=production`
- `ALLOW_DB_TESTS` diferente de `1`
- Nome da base que não termina em `_test` (salvo `TEST_DATABASE_NAME` exacto)

Suites protegidas: `auth.test.js` (parte integração), `session.pg.test.js`, `rateLimit.concurrency.test.js`.

### O que o teste de sessão comprova

- Login grava linha na tabela `session`
- **Novo processo Node** (`tests/helpers/session_child.js`) arranca a app e autentica com o mesmo cookie via PostgreSQL
- Logout e reset de palavra-passe invalidam a sessão

### Limitações conhecidas

- **Rate limit em memória**: só se a BD estiver indisponível; **não** é protecção distribuída entre instâncias.
- **TRUST_PROXY_HOPS**: spoofing mitiga-se apenas se o valor reflectir a topologia real. Na Abasthan, validar com documentação/rede — não assumir `1` sem evidência.
- **Etapa 5** ainda não iniciada.

---

## Estrutura (resumo)

```
src/
  app.js, server.js
  config/env.js
  db/pool.js
  middleware/ (auth, csrf, rateLimit, errorHandler)
  routes/ (health, auth)
  services/ (authService, email)
  utils/crypto.js
public/          # UI Etapa 3 + páginas de auth
migrations/
tests/
  helpers/testDbGuard.js
  helpers/session_child.js
```
