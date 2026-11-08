# Fase 3 — Correções (shutdown, renovação, locks, testes)

## Shutdown

- `performShutdown`: se `waitForIdle` devolver false, **não** fecha o pool.
- Para interval + timeout inicial de 15s.
- Double-shutdown protegido.

## Renovação

- Sem captura silenciosa.
- Logs sem token; guard `inFlight`.
- Falha temporária não liberta/consome a reserva.

## Locks

Ordem global: users → searches.

## Testes unitários

35/35 pass neste ambiente.

## PostgreSQL

Cenários de recuperação em `quotaHold.pg.test.js` — skipped sem BD `*_test`.

## Produção

Migrations não executadas. Job não activado. Render não alterado.
