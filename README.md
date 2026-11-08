# Maps Leads Finder SaaS

**Repositório:** https://github.com/EdilBorg/maps-leads-finder-saas  
**Especificação:** [SPECIFICATION.md](./SPECIFICATION.md)  
**Design:** [DESIGN.md](./DESIGN.md)  
**Modelo de dados:** [docs/DOMAIN_MODEL.md](./docs/DOMAIN_MODEL.md)

## Estado

| Etapa / Fase | Estado |
|-------|--------|
| 1–4 técnicas | Concluídas |
| 5 — Modelo de dados / multi-tenant | Implementada; validação PostgreSQL pendente |
| Fase 3 — Quotas, reservas e experiência de pesquisa | Implementada no código; validação PostgreSQL pendente |
| 6+ produto (pagamentos, admin) | Não iniciada |

## Validação pendente — Fase 3 (PostgreSQL)

### Estado actual

* Implementação do sistema de quotas e reservas: **concluída**.
* Mecanismo de reserva temporária (hold): **implementado**.
* Renovação e recuperação de reservas abandonadas: **implementadas**.
* Protecção contra concorrência: **implementada** no código e coberta por testes preparados.
* Testes unitários: **44 pass, 0 fail, 0 skipped**, conforme execução reportada.
* Testes de integração PostgreSQL: **ainda não executados** numa base de dados isolada.
* Validação real dos cenários A–H: **pendente**.

Classificação: **IMPLEMENTADO, PARCIALMENTE VALIDADO**.  
A implementação está publicada. A validação PostgreSQL real permanece pendente.

Documentação detalhada dos testes de integração: [docs/POSTGRESQL-INTEGRATION-TESTS.md](./docs/POSTGRESQL-INTEGRATION-TESTS.md).

### Trabalho futuro obrigatório

Quando existir disponibilidade para preparar um ambiente PostgreSQL isolado:

1. Criar uma base de dados exclusiva para testes, com nome terminado em `_test`.
2. Configurar `ALLOW_DB_TESTS=1`.
3. Confirmar que o `testDbGuard` permite a execução e que a ligação **não** aponta para produção.
4. Executar as migrations oficiais na base de dados de teste.
5. Executar:

```bash
npm run migrate
node --test tests/quotaHold.pg.test.js tests/recoveryConcurrency.pg.test.js
```

6. Verificar individualmente os oito cenários oficiais:

| ID | Cenário |
|----|---------|
| A | Aquisição concorrente |
| B | Isolamento multiutilizador |
| C | Renovação × recuperação |
| D | Persistência × recuperação |
| E | Dois jobs de recuperação |
| F | Lease expirada |
| G | Token substituído |
| H | Idempotência da recuperação |

7. Registar os resultados reais de cada cenário.
8. Corrigir eventuais falhas encontradas.
9. Actualizar a documentação com a data da execução e os resultados confirmados.

### Limitações de validação conhecidas

A cobertura dos testes ainda merece duas verificações adicionais (não são falhas confirmadas da implementação):

* **Cenário D:** confirmar que uma falha no fluxo de persistência não deixa uma promessa de recuperação pendente antes do cleanup.
* **Cenário E:** considerar um teste com duas chamadas concorrentes reais a `runOnce()`, além do teste de aquisição do advisory lock actualmente existente.

Estas verificações são pontos de cobertura que ainda precisam de validação numa BD isolada.

## Pesquisa — modalidades (UI)

- **Pesquisa padrão** — Pesquisa equilibrada (interno: Google Maps + OpenStreetMap).
- **Pesquisa ampliada** — Maior alcance (interno: Google Maps + Apify).

Os nomes dos fornecedores **não** são mostrados no frontend.

## API de pesquisa

- `POST /api/searches` — criar pesquisa (auth + email verificado + CSRF)
- `GET /api/searches` — histórico
- `GET /api/searches/dashboard` — contagens
- `GET /api/searches/:id/results` — resultados
- `GET /api/searches/leads/saved` / `POST /api/searches/leads/save`

## Credenciais de fornecedores (servidor)

Ver `.env.example`:

- `GOOGLE_MAPS_API_KEY`
- `APIFY_TOKEN` / `APIFY_ACTOR_ID`
- `OSM_NOMINATIM_URL` / `OSM_USER_AGENT` / `OSM_DISABLED`

Sem chaves, os adapters devolvem `not_configured`; a UI mostra mensagens genéricas.

## Instalação

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
npm test
```
