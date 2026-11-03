# Maps Leads Finder SaaS

Plataforma SaaS multiutilizador para pesquisa e gestão de leads comerciais a partir de múltiplos fornecedores de dados geográficos e comerciais.

**Repositório oficial:** https://github.com/EdilBorg/maps-leads-finder-saas  
**Especificação:** [SPECIFICATION.md](./SPECIFICATION.md)  
**Referência visual:** [DESIGN.md](./DESIGN.md)

---

## Estado atual

**Etapa 3 — Sistema visual e interface** (concluída)

Interface frontend implementada com o design system definido em `DESIGN.md` (midnight precision / Linear-inspired):

- Shell da aplicação (sidebar, topbar, navegação responsiva)
- Dashboard com indicadores de demonstração
- Formulário de nova pesquisa (categoria, localização, fornecedores, filtros)
- Tabela de resultados com estados empty / loading e simulação client-side
- Histórico de pesquisas e leads guardados (dados de demonstração)
- Tokens CSS, componentes e tipografia Inter alinhados à referência visual

**Etapas anteriores**

1. Especificação geral (`SPECIFICATION.md` v1.1)
2. Estrutura inicial Node.js / Express / PostgreSQL / health check

---

## Interface em modo demonstração

Disponível no protótipo visual (sem backend de negócio):

- Navegação entre Dashboard, Nova pesquisa, Resultados, Histórico e Leads
- Seleção visual de fornecedores e filtros
- Botão **Simular resultados (demo)** — preenche a tabela com dados fictícios identificados como demonstração
- Filtro client-side na tabela de resultados
- Banner permanente a indicar que os dados são de demonstração

**Ainda não implementado** (etapas posteriores):

- Autenticação (email/password, Argon2id, sessões PostgreSQL)
- Reserva de quotas e motor de pesquisa real
- Integração com fornecedores de dados
- Planos, pagamentos e painel administrativo
- Persistência de leads e histórico
- Exportação

---

## Estrutura frontend

```
public/
├── index.html          # Shell SPA (views por secção)
├── css/
│   ├── tokens.css      # Tokens de design (cores, tipografia, spacing, radii)
│   └── main.css        # Layout, componentes, estados, responsividade
└── js/
    └── app.js          # Navegação, mobile menu, simulação de resultados
```

Backend (sem alteração de arquitetura nesta etapa):

```
src/
├── app.js              # createApp() + static public/ + /api/health
├── server.js           # listen apenas como módulo principal
└── ...
```

---

## Decisões técnicas fechadas

1. **Autenticação:** email/password, **Argon2id**, sessões **PostgreSQL** (`connect-pg-simple`).
2. **Quotas:** reserva **transacional e idempotente** antes de qualquer pesquisa.
3. **Leads guardados:** **snapshots independentes** da retenção de 30 dias.

---

## Arranque rápido

```bash
git clone https://github.com/EdilBorg/maps-leads-finder-saas.git
cd maps-leads-finder-saas
npm install
cp .env.example .env
npm run dev
```

- UI: http://localhost:3000  
- Health: http://localhost:3000/api/health  

Requisitos: Node.js ≥ 20. PostgreSQL só é necessário para etapas posteriores (o health check tolera BD indisponível nesta fase).

---

## Scripts

| Comando       | Descrição                        |
|---------------|----------------------------------|
| `npm run dev` | Desenvolvimento com `--watch`    |
| `npm start`   | Produção                         |
| `npm test`    | Testes (health isolado da BD)    |

---

## Próximas etapas

4. Autenticação e gestão de sessões  
5. Base de dados, relações e permissões  
6. … (ver `SPECIFICATION.md`)

---

## Licença

UNLICENSED — projeto privado.
