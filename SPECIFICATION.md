# Maps Leads Finder SaaS — Especificação Técnica Geral

**Versão:** 1.1  
**Data:** 2026-11-03  
**Estado:** Atualizado após auditoria da Etapa 2  
**Repositório pretendido:** `EdilBorg/maps-leads-finder-saas`  
**Repositório de referência (apenas leitura):** `https://github.com/EdilBorg/maps-leads-finder`

---

## 1. Visão Geral e Objetivos do Produto

### 1.1 Visão

O **Maps Leads Finder** é uma plataforma SaaS multiutilizador que permite a prospeção comercial de empresas e estabelecimentos através de múltiplos fornecedores de dados geográficos e comerciais. O sistema pesquisa por categoria e localização, normaliza resultados de fontes distintas, elimina duplicados, aplica filtros avançados e disponibiliza os leads de forma organizada, com histórico, armazenamento temporário e exportação.

A plataforma diferencia-se da ferramenta open-source de referência por ser um produto comercial completo: contas individuais, quotas e planos de subscrição, painel administrativo, pagamentos (manual + automático), isolamento de dados e retenção controlada.

### 1.2 Objetivos de Negócio

- Permitir que utilizadores (freelancers, agências, vendedores de serviços digitais e equipas comerciais) obtenham listas de leads locais de forma rápida e repetível.
- Monetizar através de planos mensais com quotas de pesquisas e de volume de resultados.
- Oferecer uma experiência profissional, estável e segura, adequada a utilização comercial diária.
- Manter a identidade visual e a proposta de valor da ferramenta de referência, mas com arquitetura multi-tenant e escalável.

### 1.3 Objetivos Técnicos

- Aplicação web monolítica modular (frontend + backend + PostgreSQL).
- Pesquisa paralela multi-fornecedor com falha parcial tolerada.
- Normalização e deduplicação robustas.
- Controlo rigoroso de quotas e retenção de dados (30 dias).
- Segurança: credenciais de API apenas no servidor, isolamento por utilizador, auditoria de ações sensíveis.
- Deploy inicial em Abasthan PaaS.

### 1.4 Fora de Âmbito (nesta fase)

- Aplicações móveis nativas.
- Microserviços, filas dedicadas (Redis/RabbitMQ), Kubernetes.
- Enriquecimento avançado de emails/sociais além do que os fornecedores devolvem.
- CRM completo ou sequências de outreach automatizadas.
- Multi-idioma da interface (português como idioma principal inicial).

### 1.5 Decisões técnicas fechadas (v1.1)

As seguintes decisões foram fechadas e passam a fazer parte da especificação oficial:

1. **Autenticação**
   - Método: email + password.
   - Hashing de passwords: **Argon2id**.
   - Sessões: armazenadas em **PostgreSQL** via `connect-pg-simple` (não em memória nem ficheiros).

2. **Quotas**
   - Antes de qualquer pesquisa ser executada, o sistema realiza uma **reserva transacional e idempotente** de quota.
   - A reserva impede race conditions e consumo duplicado.
   - O débito definitivo ocorre apenas na conclusão bem-sucedida (ou parcial com resultados) da pesquisa.

3. **Leads guardados (saved leads)**
   - Os leads que o utilizador guarda explicitamente são armazenados como **snapshots independentes**.
   - Estes snapshots **não são eliminados** pelo job de retenção de 30 dias dos resultados de pesquisa.
   - A retenção de 30 dias aplica-se apenas aos resultados brutos/normalizados de cada pesquisa.

---

## 2. Requisitos Funcionais

### 2.1 Contas e Autenticação

- Registo de utilizador (email + password).
- Login / logout com sessões seguras armazenadas em PostgreSQL.
- Recuperação de password.
- Cada conta possui dados privados (pesquisas, leads, subscrição).
- Uma única pesquisa gratuita por conta (máximo 200 resultados).
- Após a pesquisa gratuita, novas pesquisas exigem subscrição ativa.

### 2.2 Pesquisa de Leads

- Entrada: categoria/nicho + localização (cidade, região, país ou coordenadas aproximadas).
- Consulta paralela a múltiplos fornecedores de dados independentes.
- Controlo de concorrência (limite de pedidos simultâneos por pesquisa e global).
- Se um ou mais fornecedores falharem, o sistema continua e apresenta resultados dos que responderam.
- Normalização de campos para um formato canónico único.
- Deduplicação (ver regras de negócio).
- Aplicação de filtros pós-normalização.
- Persistência da pesquisa e dos resultados associados.
- Estado da pesquisa: pending / running / completed / failed / partial.

### 2.3 Filtros Disponíveis

- Categoria.
- Localização.
- Presença de telefone.
- Presença de email.
- Classificação mínima (rating).
- Número mínimo de avaliações.
- Apenas empresas sem website.

**Nota importante:** A ausência de um campo num fornecedor não deve ser interpretada como ausência real da informação. O sistema deve distinguir “não fornecido” de “confirmadamente inexistente” sempre que possível.

### 2.4 Resultados, Histórico e Leads

- Visualização tabular e em cards dos resultados de uma pesquisa.
- Paginação e ordenação.
- Guardar leads individuais ou conjuntos (favoritos / lista de leads).
- Histórico de pesquisas do utilizador.
- Detalhe de uma pesquisa (critérios, fornecedores usados, estatísticas, resultados).
- Retenção: resultados de cada pesquisa mantidos durante 30 dias a partir da conclusão. Após expiração, eliminação automática.
- **Leads guardados** são snapshots independentes e não são afetados pela retenção de 30 dias.

### 2.5 Exportação

- Exportação dos resultados de uma pesquisa (formatos a definir em etapa posterior: CSV, XLSX, PDF, etc.).
- Exportação deve respeitar os filtros aplicados e a propriedade dos dados do utilizador.

### 2.6 Planos, Subscrições e Quotas

- Planos mensais configuráveis (nome, preço, quotas de pesquisas, quotas de resultados, outras features).
- Subscrição ativa permite novas pesquisas dentro das quotas.
- Subscrição expirada: utilizador continua a aceder à conta e a consultar dados existentes, mas não pode iniciar novas pesquisas.
- Quotas controlam número de pesquisas e volume de resultados.
- **Reserva transacional e idempotente** de quota antes de iniciar qualquer pesquisa.
- Concessão manual de subscrições pelo administrador.

### 2.7 Pagamentos

- **Pagamento manual:** utilizador submete comprovativo/referência → administrador analisa → aprova ou rejeita → só após aprovação a subscrição é ativada.
- **Pagamento automático:** integração com gateway (a escolher) + validação via webhooks no servidor. Proteção contra processamento duplicado. Não ativar subscrição apenas pelo retorno do utilizador da página de pagamento.

### 2.8 Área do Utilizador (páginas principais)

- Dashboard.
- Nova pesquisa.
- Detalhes / resultados de pesquisa.
- Histórico de pesquisas.
- Leads guardados.
- Planos e subscrição.
- Pagamentos / comprovativos.
- Perfil.
- Configurações.

### 2.9 Painel Administrativo

- Dashboard administrativo.
- Gestão de utilizadores (consultar, suspender, reativar).
- Detalhes de utilizador.
- Gestão de planos.
- Gestão de subscrições (incluindo concessão manual).
- Gestão de pagamentos (aprovar/rejeitar manuais).
- Consulta de pesquisas e utilização.
- Gestão de fornecedores de APIs (ativar/desativar, credenciais, limites).
- Registos de auditoria.
- Configurações do sistema.

Operações administrativas sensíveis devem ser registadas em auditoria.

---

## 3. Requisitos Não Funcionais

| Categoria              | Requisito |
|------------------------|-----------|
| Segurança              | Credenciais de APIs exclusivamente no servidor. Isolamento total de dados por utilizador. Proteção de rotas. Validação de inputs. Sessões seguras (httpOnly, secure, sameSite). Passwords com **Argon2id**. |
| Desempenho             | Pesquisas paralelas com limite de concorrência. Resposta de UI rápida. Paginação de resultados. |
| Escalabilidade         | Arquitetura modular que permita crescimento vertical inicial e, mais tarde, horizontal se necessário. Evitar dependências prematuras de Redis/K8s. |
| Disponibilidade        | Tolerância a falha parcial de fornecedores. Jobs de limpeza de dados expirados. |
| Manutenibilidade       | Código modular, adapters por fornecedor, tratamento centralizado de erros, logging estruturado. |
| Usabilidade            | Interface dark profissional, responsiva, hierarquia clara, tabelas compactas. |
| Retenção               | Dados de resultados de pesquisa eliminados automaticamente após 30 dias. Leads guardados (snapshots) não são eliminados por este job. |
| Observabilidade        | Logs de erros, auditoria de ações admin e de operações críticas de pagamento/pesquisa. |
| Conformidade           | Não inventar dados que os fornecedores não devolveram. Respeito pelos termos de uso dos fornecedores. |

---

## 4. Arquitetura Proposta

### 4.1 Visão de Alto Nível

```
[Browser - HTML/CSS/JS Vanilla]
          │
          ▼ HTTPS
[Node.js + Express - API + Serving estático]
          │
          ├── Auth & Session (PostgreSQL store)
          ├── Search Engine (orquestração)
          ├── Provider Adapters (A, B, C…)
          ├── Quota & Subscription Service (reserva transacional)
          ├── Payment Service (manual + webhook)
          ├── Admin Service
          └── Cleanup Jobs
          │
          ▼
[PostgreSQL]
```

- **Monólito modular**: uma única aplicação Node.js/Express que serve o frontend estático e a API.
- Separação clara de responsabilidades por pastas/módulos.
- Frontend: páginas HTML + CSS (identidade visual da referência) + JavaScript Vanilla (fetch para a API).
- Backend: rotas Express, serviços de domínio, adapters de fornecedores, acesso a dados via camada de repositório ou queries parametrizadas.
- Base de dados: PostgreSQL (relação, integridade, índices, jobs de limpeza).

### 4.2 Princípios

- Não microserviços nesta fase.
- Sessões em PostgreSQL (`connect-pg-simple`).
- Chaves de API nunca expostas ao cliente.
- Cada fornecedor isolado num adapter com interface comum.
- Normalização e deduplicação no backend, após recolha.
- Todas as operações de escrita sensíveis (pagamentos, alteração de planos, suspensão de contas) passam por validação de permissões e auditoria.

### 4.3 Fluxo de uma Pesquisa (resumo)

1. Utilizador submete critérios + filtros.
2. Backend valida autenticação, **reserva quota de forma transacional e idempotente**, e valida inputs.
3. Cria registo de pesquisa (estado `running`).
4. Dispara adapters em paralelo (com semáforo de concorrência).
5. Cada adapter devolve resultados brutos ou erro.
6. Motor normaliza, deduplica e aplica filtros.
7. Persiste resultados e atualiza estado (`completed` / `partial` / `failed`).
8. Confirma o débito de quotas.
9. Frontend faz polling ou recebe estado final e mostra resultados.

---

## 5. Tecnologias e Responsabilidades

| Camada / Componente       | Tecnologia                  | Responsabilidade |
|---------------------------|-----------------------------|------------------|
| Frontend                  | HTML, CSS, JavaScript Vanilla | UI, formulários, tabelas, chamadas à API, identidade visual |
| Backend                   | Node.js + Express           | API REST, autenticação, orquestração de pesquisa, regras de negócio, webhooks |
| Base de dados             | PostgreSQL                  | Persistência de utilizadores, pesquisas, leads, planos, subscrições, pagamentos, auditoria, sessões |
| Sessões                   | express-session + connect-pg-simple | Gestão de sessões autenticadas em PostgreSQL |
| Password hashing          | Argon2id                    | Hash seguro de passwords |
| Controlo de versão        | Git + GitHub                | Código-fonte do novo repositório |
| Hospedagem inicial        | Abasthan PaaS               | Deploy da aplicação e PostgreSQL |
| Fontes de dados           | Fornecedores externos (a definir) | Dados brutos de empresas |
| Pagamentos                | Gateway a escolher + fluxo manual | Cobrança e ativação de subscrições |

**Proibições explícitas nesta fase:** React, Vue, Angular, microserviços, Redis como dependência obrigatória, Kubernetes.

---

## 6–16

*(Secções 6 a 16 mantêm o conteúdo da v1.0, com os ajustamentos já refletidos nas secções anteriores para autenticação, quotas e leads guardados. O modelo de entidades de `saved_leads` trata-os como snapshots independentes da retenção de 30 dias.)*

### Atualização específica em saved_leads

- **saved_leads**  
  id, user_id, snapshot de dados do lead (independente da retenção de 30 dias), notes, created_at.  
  *Nota (v1.1): leads guardados são snapshots e não são eliminados pelo job de retenção de resultados de pesquisa.*

### Segurança (atualização)

- Passwords com hash forte (**Argon2id**).
- Sessões com store PostgreSQL.

---

## Resumo das Decisões Estabelecidas (v1.1)

- Projeto novo, independente, desenvolvido de raiz.
- Stack: HTML/CSS/JS Vanilla + Node.js/Express + PostgreSQL + GitHub + Abasthan.
- Multiutilizador com isolamento de dados.
- Uma pesquisa gratuita (máx. 200 resultados) por conta.
- Planos mensais com quotas de pesquisas e de resultados.
- **Reserva transacional e idempotente de quotas antes das pesquisas.**
- Retenção de resultados de pesquisa: 30 dias.
- **Leads guardados: snapshots independentes da retenção de 30 dias.**
- **Autenticação: email/password, Argon2id, sessões PostgreSQL.**
- Pesquisa multi-fornecedor em paralelo com normalização + deduplicação + filtros.
- Pagamentos manuais (aprovação admin) + automáticos (webhooks).
- Painel administrativo completo.
- Identidade visual oficial (paleta fornecida + Inter + dark).
- Arquitetura monolítica modular, sem microserviços nem Redis/K8s nesta fase.

---

*Documento atualizado para v1.1 após auditoria da Etapa 2. Nenhuma implementação de funcionalidades das etapas seguintes foi realizada nesta correção.*
