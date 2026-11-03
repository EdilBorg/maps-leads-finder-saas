# Maps Leads Finder SaaS — Especificação Técnica Geral

**Versão:** 1.0  
**Data:** 2026-11-03  
**Estado:** Aprovação pendente (Prompt 1)  
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

---

## 2. Requisitos Funcionais

### 2.1 Contas e Autenticação

- Registo de utilizador (email + password ou mecanismo a definir).
- Login / logout com sessões seguras.
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

### 2.5 Exportação

- Exportação dos resultados de uma pesquisa (formatos a definir em etapa posterior: CSV, XLSX, PDF, etc.).
- Exportação deve respeitar os filtros aplicados e a propriedade dos dados do utilizador.

### 2.6 Planos, Subscrições e Quotas

- Planos mensais configuráveis (nome, preço, quotas de pesquisas, quotas de resultados, outras features).
- Subscrição ativa permite novas pesquisas dentro das quotas.
- Subscrição expirada: utilizador continua a aceder à conta e a consultar dados existentes, mas não pode iniciar novas pesquisas.
- Quotas controlam número de pesquisas e volume de resultados.
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
| Segurança              | Credenciais de APIs exclusivamente no servidor. Isolamento total de dados por utilizador. Proteção de rotas. Validação de inputs. Sessões seguras (httpOnly, secure, sameSite). |
| Desempenho             | Pesquisas paralelas com limite de concorrência. Resposta de UI rápida. Paginação de resultados. |
| Escalabilidade         | Arquitetura modular que permita crescimento vertical inicial e, mais tarde, horizontal se necessário. Evitar dependências prematuras de Redis/K8s. |
| Disponibilidade        | Tolerância a falha parcial de fornecedores. Jobs de limpeza de dados expirados. |
| Manutenibilidade       | Código modular, adapters por fornecedor, tratamento centralizado de erros, logging estruturado. |
| Usabilidade            | Interface dark profissional, responsiva, hierarquia clara, tabelas compactas. |
| Retenção               | Dados de resultados de pesquisa eliminados automaticamente após 30 dias. |
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
          ├── Auth & Session
          ├── Search Engine (orquestração)
          ├── Provider Adapters (A, B, C…)
          ├── Quota & Subscription Service
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
- Não Redis obrigatório (sessões podem usar store em PostgreSQL ou memória controlada; preferir store persistente).
- Chaves de API nunca expostas ao cliente.
- Cada fornecedor isolado num adapter com interface comum.
- Normalização e deduplicação no backend, após recolha.
- Todas as operações de escrita sensíveis (pagamentos, alteração de planos, suspensão de contas) passam por validação de permissões e auditoria.

### 4.3 Fluxo de uma Pesquisa (resumo)

1. Utilizador submete critérios + filtros.
2. Backend valida autenticação, quotas e inputs.
3. Cria registo de pesquisa (estado `running`).
4. Dispara adapters em paralelo (com semáforo de concorrência).
5. Cada adapter devolve resultados brutos ou erro.
6. Motor normaliza, deduplica e aplica filtros.
7. Persiste resultados e atualiza estado (`completed` / `partial` / `failed`).
8. Debita quotas.
9. Frontend faz polling ou recebe estado final e mostra resultados.

---

## 5. Tecnologias e Responsabilidades

| Camada / Componente       | Tecnologia                  | Responsabilidade |
|---------------------------|-----------------------------|------------------|
| Frontend                  | HTML, CSS, JavaScript Vanilla | UI, formulários, tabelas, chamadas à API, identidade visual |
| Backend                   | Node.js + Express           | API REST, autenticação, orquestração de pesquisa, regras de negócio, webhooks |
| Base de dados             | PostgreSQL                  | Persistência de utilizadores, pesquisas, leads, planos, subscrições, pagamentos, auditoria |
| Sessões                   | express-session + store (PostgreSQL ou ficheiro seguro) | Gestão de sessões autenticadas |
| Controlo de versão        | Git + GitHub                | Código-fonte do novo repositório |
| Hospedagem inicial        | Abasthan PaaS               | Deploy da aplicação e PostgreSQL |
| Fontes de dados           | Fornecedores externos (a definir) | Dados brutos de empresas |
| Pagamentos                | Gateway a escolher + fluxo manual | Cobrança e ativação de subscrições |

**Proibições explícitas nesta fase:** React, Vue, Angular, microserviços, Redis como dependência obrigatória, Kubernetes.

---

## 6. Módulos do Sistema

### 6.1 Frontend

- Páginas estáticas / templates servidos pelo Express.
- CSS baseado na paleta e tipografia oficiais (Inter + variáveis CSS da referência).
- Módulos JS por área (auth, search, results, admin, etc.).

### 6.2 Backend — Core

- **Auth Module**: registo, login, logout, recuperação de password, middleware de proteção de rotas.
- **User Module**: perfil, configurações.
- **Search Module**: criação de pesquisa, orquestração, estado.
- **Provider Adapters**: um adapter por fornecedor, interface comum (`search(criteria) → Promise<RawResults | Error>`).
- **Normalization & Deduplication Service**.
- **Filter Service**.
- **Quota & Subscription Service**.
- **Payment Module**: submissão manual, webhooks, idempotência.
- **Admin Module**: CRUDs e ações sensíveis.
- **Audit Logger**.
- **Cleanup Job**: eliminação de resultados com mais de 30 dias.
- **Error Handler** centralizado.

### 6.3 Base de Dados

- Schema relacional com chaves estrangeiras e índices adequados.
- Soft-delete ou hard-delete conforme política (resultados de pesquisa: hard-delete após 30 dias).

---

## 7. Fluxos Principais de Utilização

### 7.1 Registo e Primeira Pesquisa Gratuita

1. Utilizador cria conta.
2. Sistema associa quota gratuita (1 pesquisa, ≤ 200 resultados).
3. Utilizador realiza a pesquisa gratuita.
4. Após conclusão, a quota gratuita é consumida.
5. Novas pesquisas bloqueadas até existir subscrição ativa.

### 7.2 Pesquisa Paga

1. Utilizador com subscrição ativa e quota disponível inicia pesquisa.
2. Sistema valida quotas → cria pesquisa → executa fornecedores → normaliza → deduplica → filtra → persiste → debita quotas.
3. Utilizador consulta resultados e pode exportar / guardar leads.

### 7.3 Pagamento Manual

1. Utilizador escolhe plano e submete comprovativo/referência.
2. Estado do pagamento: `pending`.
3. Administrador analisa e aprova ou rejeita.
4. Em caso de aprovação: cria/atualiza subscrição e regista auditoria.

### 7.4 Pagamento Automático

1. Utilizador inicia checkout no gateway.
2. Gateway notifica via webhook.
3. Backend valida assinatura do webhook, idempotência e estado do pagamento.
4. Só então ativa a subscrição.

### 7.5 Expiração de Subscrição

- Subscrição passa a `expired`.
- Utilizador mantém acesso de leitura aos seus dados históricos.
- Novas pesquisas são recusadas com mensagem clara.

### 7.6 Limpeza Automática

- Job periódico identifica pesquisas concluídas há mais de 30 dias e remove os resultados associados (e eventualmente a pesquisa, conforme política final).

---

## 8. Regras de Negócio

1. **Pesquisa gratuita**: exatamente uma por conta; máximo 200 resultados; consumida na conclusão da pesquisa.
2. **Subscrição ativa** é pré-requisito para qualquer pesquisa adicional.
3. **Quotas**: número de pesquisas + volume de resultados (configurável por plano). Débito atómico na conclusão bem-sucedida (ou parcial com resultados).
4. **Retenção**: 30 dias a partir da data de conclusão da pesquisa.
5. **Deduplicação** (ordem de prioridade sugerida):
   - Identificador externo do fornecedor (quando disponível e fiável).
   - Telefone normalizado (E.164 ou equivalente local).
   - Combinação nome normalizado + localização aproximada (com correspondência cautelosa para evitar falsos positivos).
6. **Falha parcial de fornecedores**: pesquisa pode terminar como `partial` e ainda assim devolver resultados úteis.
7. **Não inventar dados**: campos em falta permanecem nulos/ausentes; o sistema não preenche por inferência agressiva.
8. **Isolamento**: um utilizador nunca vê dados de outro.
9. **Pagamento manual**: subscrição só ativa após aprovação explícita do administrador.
10. **Pagamento automático**: ativação apenas após validação de webhook fiável e verificação de idempotência.
11. **Administradores** têm papel distinto e permissões elevadas; ações sensíveis são auditadas.
12. Contas podem ser suspensas pelo administrador (impede login ou impede novas ações).

---

## 9. Proposta Inicial de Entidades da Base de Dados

### 9.1 Principais Entidades

- **users**  
  id, email, password_hash, name, role (`user` | `admin`), status (`active` | `suspended`), free_search_used (boolean), created_at, updated_at, last_login_at.

- **plans**  
  id, name, description, price_cents, currency, max_searches_per_month, max_results_per_month, max_results_per_search, features (jsonb), is_active, created_at, updated_at.

- **subscriptions**  
  id, user_id, plan_id, status (`active` | `expired` | `cancelled` | `pending`), starts_at, ends_at, source (`manual` | `gateway`), external_ref, created_at, updated_at.

- **payments**  
  id, user_id, subscription_id (nullable), plan_id, amount_cents, currency, method (`manual` | `gateway`), status (`pending` | `approved` | `rejected` | `completed` | `failed`), proof_url / reference, gateway_payload (jsonb), idempotency_key, reviewed_by, reviewed_at, created_at, updated_at.

- **searches**  
  id, user_id, query (categoria), location, filters (jsonb), status (`pending` | `running` | `completed` | `partial` | `failed`), providers_used (jsonb), total_raw, total_normalized, total_after_dedup, total_after_filters, error_summary, started_at, completed_at, expires_at, created_at.

- **search_results** (ou **leads** da pesquisa)  
  id, search_id, user_id, normalized data (name, address, phone, email, website, rating, reviews_count, category, lat, lng, source_provider, external_id, raw_payload jsonb, is_duplicate_of, etc.), created_at.

- **saved_leads**  
  id, user_id, search_result_id (ou dados desnormalizados), notes, created_at.

- **api_providers**  
  id, code, name, is_enabled, config (jsonb – sem secrets em claro se possível), rate_limits, created_at, updated_at.

- **audit_logs**  
  id, actor_user_id, action, entity_type, entity_id, metadata (jsonb), ip, created_at.

- **system_settings**  
  key, value (jsonb), updated_at.

### 9.2 Índices e Considerações

- Índices em `user_id` nas tabelas de pesquisas e resultados.
- Índice em `searches.expires_at` para o job de limpeza.
- Índice único em email de utilizadores.
- Índice em `payments.idempotency_key`.
- Constraints de integridade referencial com `ON DELETE` adequado (cascade controlado).

**Nota:** Esta é uma proposta inicial. O modelo será refinado na etapa de base de dados (Prompt 5).

---

## 10. Segurança e Isolamento dos Dados

- Todas as queries de dados de utilizador filtram obrigatoriamente por `user_id` do utilizador autenticado (exceto rotas admin).
- Middleware de autenticação e de autorização por role.
- Passwords com hash forte (bcrypt/argon2).
- Sessões com cookie httpOnly + secure + sameSite.
- Validação e sanitização de todos os inputs.
- Rate limiting em endpoints sensíveis (login, criação de pesquisa, submissão de pagamento).
- Secrets (API keys, session secret, gateway secrets) apenas em variáveis de ambiente / secrets do PaaS.
- Proteção CSRF onde aplicável (especialmente formulários de estado).
- Headers de segurança (Helmet ou equivalente).
- Logs de auditoria para ações admin e alterações de subscrição/pagamento.
- Isolamento lógico multi-tenant (não partilha de dados entre utilizadores).

---

## 11. Estratégia de Integração de APIs (Fornecedores)

- **Interface comum** para todos os adapters:

  ```js
  async function search(criteria) {
    // criteria: { query, location, limit, ... }
    // retorna: { results: RawResult[], meta }
    // ou lança / retorna erro controlado
  }
  ```

- Cada fornecedor vive num ficheiro/módulo isolado.
- Configuração (keys, endpoints, limites) carregada do ambiente ou da tabela `api_providers` (secrets nunca no frontend).
- Execução em paralelo com limite de concorrência (ex.: p-limit ou semáforo simples).
- Timeout por fornecedor.
- Tratamento de erros individual: um fornecedor em baixo não derruba a pesquisa inteira.
- Normalização posterior mapeia campos diferentes para o schema canónico.
- Possibilidade de ativar/desativar fornecedores via painel admin sem deploy.

**Fornecedores concretos:** ainda não escolhidos. O sistema deve nascer preparado para receber 2+ adapters.

---

## 12. Estratégia de Escalabilidade e Desempenho

- **Fase inicial:** escalar verticalmente no Abasthan (mais CPU/RAM).
- Controlo de concorrência por pesquisa e global para não esgotar quotas dos fornecedores nem saturar o processo Node.
- Resultados paginados na API e na UI.
- Índices adequados no PostgreSQL.
- Job de limpeza de dados antigos para controlar crescimento da tabela de resultados.
- Evitar carregar todos os resultados de uma pesquisa grande em memória de uma só vez quando possível.
- Caching futuro (opcional) de resultados de geocoding ou de pesquisas idênticas recentes — não obrigatório na v1.
- Monitorização básica de tempo de resposta das pesquisas e taxa de erro por fornecedor.

---

## 13. Estrutura de Permissões

| Recurso / Ação                    | Utilizador autenticado | Administrador |
|-----------------------------------|------------------------|---------------|
| Ver/editar próprio perfil         | Sim                    | Sim           |
| Criar pesquisa (com quota)        | Sim                    | Sim           |
| Ver próprias pesquisas/leads      | Sim                    | Sim           |
| Exportar próprios resultados      | Sim                    | Sim           |
| Gerir utilizadores                | Não                    | Sim           |
| Suspender/reativar contas         | Não                    | Sim           |
| Gerir planos e subscrições        | Não                    | Sim           |
| Aprovar/rejeitar pagamentos       | Não                    | Sim           |
| Gerir fornecedores de API         | Não                    | Sim           |
| Ver auditoria e utilização global | Não                    | Sim           |
| Configurações do sistema          | Não                    | Sim           |

Role armazenado no utilizador. Middleware verifica role antes de rotas `/admin/*`.

---

## 14. Riscos Técnicos Identificados

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Dependência de fornecedores externos (rate limits, custos, downtime) | Alto | Múltiplos adapters, falha parcial tolerada, monitorização, possibilidade de desativar fornecedor |
| Custo imprevisível das APIs de dados | Alto | Quotas por plano, limites por pesquisa, alertas de consumo |
| Deduplicação imperfeita (falsos positivos/negativos) | Médio | Regras cautelosas, priorizar identificadores fortes, logging de decisões de dedup |
| Crescimento rápido da tabela de resultados | Médio | Retenção de 30 dias + job de limpeza + índices |
| Processamento duplicado de webhooks de pagamento | Alto | Idempotency keys + estado transacional |
| Sessões e autenticação inseguras | Alto | Boas práticas de cookies, hashing, rate limit no login |
| Complexidade prematura | Médio | Manter monólito modular, evitar Redis/K8s até justificado |
| Abasthan PaaS limitações (cold start, recursos) | Médio | Testes de carga iniciais, configuração adequada de processos |

---

## 15. Decisões Ainda Pendentes

1. **Fornecedores de dados concretos** (quais APIs / scrapers / serviços serão os adapters iniciais).
2. **Gateway de pagamento** para o fluxo automático.
3. **Preços e quotas exactas dos planos pagos**.
4. **Formatos definitivos de exportação** (CSV, XLSX, PDF, JSON…).
5. **Mecanismo exacto de autenticação** (email/password clássico, magic link, OTP, etc.) — a referência antiga usava OTP por email; a decidir para o SaaS.
6. **Política exacta de soft-delete vs hard-delete** e se a pesquisa em si é mantida após limpeza dos resultados.
7. **Limites de concorrência e timeouts** por fornecedor e globais.
8. **Estratégia de armazenamento de comprovativos de pagamento manual** (upload de ficheiro vs referência textual).
9. **Idioma(s) da interface** e eventual i18n futuro.
10. **Política de rate limiting** detalhada e mensagens de erro ao utilizador.
11. **Backup e restore** no Abasthan (frequência, retenção).
12. **Nome de domínio e branding final** (se diferente de “Maps Leads Finder”).

Estas decisões serão tomadas em etapas posteriores ou por aprovação explícita do product owner.

---

## 16. Critérios de Aceitação do Projeto (visão global)

O SaaS será considerado pronto para utilização comercial quando:

1. Um utilizador consegue registar-se, realizar a pesquisa gratuita (≤ 200 resultados) e ver os resultados normalizados e deduplicados.
2. Após a pesquisa gratuita, novas pesquisas são bloqueadas até existir subscrição ativa.
3. Um administrador consegue criar planos, conceder subscrições e aprovar pagamentos manuais.
4. Uma pesquisa com múltiplos fornecedores funciona em paralelo e tolera falha de um fornecedor.
5. Filtros (telefone, email, rating, reviews, sem website, etc.) são aplicados corretamente.
6. Resultados expiram e são eliminados após 30 dias.
7. Dados de um utilizador nunca são visíveis a outro.
8. Pagamentos automáticos (quando o gateway estiver integrado) só ativam subscrição após validação de webhook idempotente.
9. A identidade visual (paleta, tipografia Inter, dark theme, Acid Lime como cor de ação) é respeitada.
10. O sistema corre de forma estável no Abasthan PaaS com PostgreSQL.
11. Existe painel administrativo funcional com as capacidades listadas.
12. Logs de auditoria registam as ações sensíveis.

---

## Resumo das Decisões Estabelecidas

- Projeto novo, independente, desenvolvido de raiz (não fork do repositório antigo).
- Stack: HTML/CSS/JS Vanilla + Node.js/Express + PostgreSQL + GitHub + Abasthan.
- Multiutilizador com isolamento de dados.
- Uma pesquisa gratuita (máx. 200 resultados) por conta.
- Planos mensais com quotas de pesquisas e de resultados.
- Retenção de resultados de pesquisa: 30 dias.
- Pesquisa multi-fornecedor em paralelo com normalização + deduplicação + filtros.
- Pagamentos manuais (aprovação admin) + automáticos (webhooks).
- Painel administrativo completo.
- Identidade visual oficial (paleta fornecida + Inter + dark).
- Arquitetura monolítica modular, sem microserviços nem Redis/K8s nesta fase.
- Desenvolvimento por etapas controladas; esta é a etapa 1 (especificação).

---

## Questões que Ainda Precisam de Decisão

- Quais os fornecedores de dados iniciais?
- Qual o gateway de pagamento?
- Quais os valores e quotas dos planos pagos?
- Formatos de exportação prioritários?
- Método de autenticação definitivo?
- Detalhes de armazenamento de comprovativos e de limpeza de dados?

---

## Riscos e Recomendações

**Riscos principais:** dependência e custo dos fornecedores de dados; deduplicação imperfeita; crescimento de dados; segurança de pagamentos e sessões.

**Recomendações:**

1. Começar com 1–2 fornecedores bem conhecidos e estáveis, com adapters limpos.
2. Implementar quotas e limites de resultados desde o início para controlar custos.
3. Manter a deduplicação conservadora (preferir falsos negativos a falsos positivos agressivos).
4. Priorizar segurança de autenticação, sessões e webhooks antes de features cosméticas.
5. Documentar cada decisão técnica nas etapas seguintes para manter consistência.
6. Não avançar para implementação de código até aprovação desta especificação e do Prompt 2.

---

## Confirmação

A presente **SPECIFICATION.md** está completa e organizada para servir de referência estável a todas as etapas posteriores do projeto Maps Leads Finder SaaS.

**Aguardo a tua aprovação explícita antes de avançar para o Prompt 2 (Estrutura inicial e configuração).**

---

*Documento gerado no âmbito do Prompt 1 — Especificação Geral. Nenhuma implementação de código ou estrutura de aplicação foi realizada.*
