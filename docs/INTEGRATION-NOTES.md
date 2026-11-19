# Notas de integração (searchService / searchEngine)

O commit local completo era 41a23c6 e incluía também:

1. src/services/quotaService.js — authorizeAndReserve, commitProviderMetrics, getClientQuotaView
2. src/services/providerUsageService.js — reserve/commit/release atómicos + TomTom global
3. src/services/paymentService.js — createManualPayment, approve/reject idempotentes
4. src/routes/billing.js e src/routes/admin.js
5. Alterações a searchService.startSearch (trial vs paid)
6. searchEngine allowedProviders + metrics
7. baseProvider okResult(results, metrics)
8. rawCount em apify/brightdata/tomtom providers
9. UI Planos em public/index.html + public/js/app.js

Este ZIP parcial contém migration + planService + subscriptionService.
Os restantes serviços completos precisam de ser repostos a partir do ambiente
onde o commit 41a23c6 foi criado, ou reimplementados conforme o relatório
da sessão de implementação.

Pedido recomendado: pedir push da branch com o pacote completo ou
reexecução da implementação completa com push autorizado.
