# Billing, quotas, trial e pagamentos

Branch: `feat/brightdata-provider-replacement`

## Componentes
- Migration `014_provider_quotas_and_usage.sql`
- Serviços: plan, subscription, providerUsage, quota, payment
- Rotas: `/api/billing/*`, `/api/admin/*` (planos, pagamentos, usage, TomTom, pricing)
- Integração em `searchService` / `searchEngine` (trial vs paid, `skipped_quota`, métricas brutas)
- UI: vista Planos

## Política trial vs paid
Se o trial ainda estiver disponível, a pesquisa usa o trial (não consome quotas pagas).
Após `free_search_used`, é necessária subscrição activa.

## TomTom global
Limite só se `system_settings.tomtom_global_quota.max_calls_per_period` estiver definido.
