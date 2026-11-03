# Maps Leads Finder SaaS

Plataforma SaaS multiutilizador para pesquisa e gestão de leads comerciais a partir de múltiplos fornecedores de dados geográficos e comerciais.

**Repositório oficial:** https://github.com/EdilBorg/maps-leads-finder-saas  
**Especificação:** [SPECIFICATION.md](./SPECIFICATION.md)

---

## Estado atual

**Etapa 2 — Estrutura inicial e configuração** (concluída)

- Aplicação Node.js 20+ + Express
- Frontend preparado (HTML / CSS / JavaScript Vanilla)
- PostgreSQL (módulo de conexão configurável por variáveis de ambiente)
- Endpoint `GET /api/health`
- Middleware centralizado de erros
- Validação de configuração
- Estrutura modular pronta para as próximas etapas

**Ainda não implementado** (pertence a etapas posteriores):

- Tabelas e migrações
- Autenticação (email/password + Argon2id + sessões PostgreSQL)
- Reserva de quotas
- Motor de pesquisa e fornecedores
- Planos, pagamentos e painel administrativo

---

## Decisões técnicas fechadas (incorporadas)

1. **Autenticação:** email/password, hashing com **Argon2id**, sessões armazenadas em **PostgreSQL** (`connect-pg-simple`).
2. **Quotas:** reserva **transacional e idempotente** antes de iniciar qualquer pesquisa.
3. **Leads guardados:** armazenados como **snapshots independentes** da retenção de 30 dias dos resultados de pesquisa.

---

## Requisitos

- Node.js **≥ 20**
- PostgreSQL (para etapas seguintes; o health check tolera ausência de BD nesta fase)

---

## Arranque rápido

```bash
# 1. Clonar
git clone https://github.com/EdilBorg/maps-leads-finder-saas.git
cd maps-leads-finder-saas

# 2. Instalar dependências
npm install

# 3. Configurar ambiente
cp .env.example .env
# Editar .env (pelo menos SESSION_SECRET; DATABASE_URL quando tiver PostgreSQL)

# 4. Desenvolvimento (com reload)
npm run dev

# 5. Produção
npm start
```

Servidor: http://localhost:3000  
Health: http://localhost:3000/api/health

---

## Scripts

| Comando        | Descrição                          |
|----------------|------------------------------------|
| `npm run dev`  | Arranca com `--watch` (Node 20+)   |
| `npm start`    | Arranca o servidor                 |
| `npm test`     | Executa testes básicos             |

---

## Estrutura do projeto

```
maps-leads-finder-saas/
├── public/                 # Frontend estático (HTML, CSS, JS Vanilla)
│   └── css/
│       └── main.css        # Paleta oficial + tipografia Inter
├── src/
│   ├── config/
│   │   └── env.js          # Validação e carregamento de variáveis
│   ├── db/
│   │   └── pool.js         # Pool PostgreSQL (sem tabelas ainda)
│   ├── middleware/
│   │   └── errorHandler.js # 404 + error handler centralizado
│   ├── routes/
│   │   └── health.js       # GET /api/health
│   ├── services/           # (reservado para lógica de domínio)
│   ├── utils/              # (reservado)
│   └── server.js           # Entry point
├── tests/
│   └── health.test.js
├── scripts/                # (reservado para migrações, seeds, etc.)
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── SPECIFICATION.md
```

---

## Variáveis de ambiente

Ver `.env.example`. Principais:

| Variável         | Obrigatório em produção | Descrição                          |
|------------------|-------------------------|------------------------------------|
| `NODE_ENV`       | Não                     | `development` / `production`       |
| `PORT`           | Não                     | Porta (default 3000)               |
| `SESSION_SECRET` | Sim                     | Segredo forte para sessões         |
| `DATABASE_URL`   | Sim                     | Connection string PostgreSQL       |

Nenhuma chave de API ou segredo é exposta ao frontend.

---

## Próximas etapas (roadmap)

1. ~~Especificação geral~~  
2. ~~Estrutura inicial e configuração~~ ← **atual**  
3. Sistema visual e interface  
4. Autenticação e gestão de sessões  
5. Base de dados, relações e permissões  
6. … (ver SPECIFICATION.md)

---

## Licença

UNLICENSED — projeto privado.
