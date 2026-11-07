# Fase 3 — Correções críticas (auditoria)

## Problemas identificados

1. **Quota gratuita concorrente** — `FOR UPDATE` + `COMMIT` antes dos fornecedores libertava o lock.
2. **Testes do motor** — helpers isolados, não `executeSearch()` com mocks.
3. **OSM/Overpass** — cobertura incompleta de `way` comercial; regex frágil.
4. **Apify** — substituição de templates podia invalidar JSON.
5. **Mensagens de cliente** — alinhamento às regras de negócio.

## Reserva atómica

- Migration `008_free_search_hold.sql`
- `src/services/freeSearchHold.js`
- Acquire / consume / release por token; TTL `FREE_SEARCH_HOLD_MINUTES` (default 20)
- Sem transação aberta durante providers

| Resultado | Quota |
|-----------|-------|
| Resultados / parcial com dados | Consome |
| Sem resultados / falha total / falha persistência | Liberta hold |

## Testes (40 unitários, todos passed neste ambiente)

- searchEngine.execute.test.js
- searchEngine.test.js
- quotaHold.test.js
- osmProvider.test.js
- apifyProvider.test.js

PostgreSQL real e APIs externas: **não executados**.

## Render

- `npm run migrate` (inclui 008)
- Credenciais de fornecedores conforme `.env.example`
