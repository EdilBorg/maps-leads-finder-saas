# Fase 3 — Correções críticas (quota, concorrência, persistência)

## Problemas confirmados
1. `consumeFreeSearchHold` não exigia `free_search_used=FALSE` nem `hold_until > NOW()`.
2. `runAndPersist` ignorava o retorno de consume e fazia COMMIT.
3. TTL sem renovação durante pesquisas longas.
4. Testes de concorrência só com mocks.
5. Pesquisas `running` abandonadas sem recuperação.
6. OSM sem `relation`.

## Soluções
- Consume SQL: token + used=false + until > NOW().
- COMMIT só se consume confirmar (senão ROLLBACK + failed/hold_lost).
- `renewFreeSearchHold` + interval durante providers.
- `recoverAbandonedSearches` para running antigas.
- Migration 009: `free_search_hold_search_id`.

## Testes
| Suite | Tipo | Este ambiente |
|-------|------|---------------|
| quotaHold.test.js | unitário mock | pass |
| quotaHold.pg.test.js | integração PG | **skipped** (sem ALLOW_DB_TESTS) |
| motor/OSM/Apify | unitário | pass |

Produção não foi migrada nesta tarefa.
