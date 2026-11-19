# Billing / Quotas / Plans — pacote de ficheiros

Commit de referência da branch antes desta feature: 06719a36540a10d90eb396f74640bcc3e76683c1
Branch: feat/brightdata-provider-replacement

## Conteúdo
- migrations/014_provider_quotas_and_usage.sql
- Serviços: planService, subscriptionService, providerUsageService, quotaService, paymentService
- Rotas: billing.js, admin.js (completo)
- Testes unitários de período, constantes de quota e idempotência de pagamentos

## Aplicar
1. Copiar os ficheiros para a raiz do projecto (respeitar paths).
2. Integrar searchService.js e searchEngine.js conforme o relatório da implementação
   (gate authorizeAndReserve + allowedProviders + metrics).
3. Montar em src/app.js: app.use('/api/billing', billingRouter)
4. Correr migration 014 apenas em ambiente de desenvolvimento/teste.
5. NÃO aplicar em produção sem aprovação.

Nota: este ZIP contém os ficheiros *novos* e a migration.
As alterações a searchService/searchEngine/providers/app.js/public
estavam no commit local 41a23c6 que não foi publicado no GitHub.
