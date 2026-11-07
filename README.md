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
| Fase 3 — Experiência de pesquisa e integração | Em curso (motor + UI modalidades + API) |
| 6+ produto (pagamentos, admin) | Não iniciada |

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
