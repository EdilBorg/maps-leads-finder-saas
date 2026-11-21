-- Pro plan + commercial lead holds + FX cache + PayZeno payment fields
-- Idempotent.

INSERT INTO plans (
  name, description, price_cents, currency,
  max_searches_per_month, max_results_per_month, max_results_per_search,
  features, is_active
) VALUES (
  'Pro',
  'Plano Pro — 2.500 leads entregues por ciclo de 30 dias. Pesquisas ilimitadas em quantidade.',
  1999,
  'USD',
  0,
  2500,
  500,
  '{"periodDays":30,"unlimitedSearches":true,"deliveredLeadsPerPeriod":2500}'::jsonb,
  TRUE
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency,
  max_searches_per_month = EXCLUDED.max_searches_per_month,
  max_results_per_month = EXCLUDED.max_results_per_month,
  max_results_per_search = EXCLUDED.max_results_per_search,
  features = EXCLUDED.features,
  is_active = TRUE,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS lead_quota_holds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  search_id         UUID NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  reserved_count    INTEGER NOT NULL CHECK (reserved_count >= 0),
  committed_count   INTEGER NOT NULL DEFAULT 0 CHECK (committed_count >= 0),
  status            TEXT NOT NULL DEFAULT 'held'
                      CHECK (status IN ('held', 'committed', 'released')),
  idempotency_key   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lead_quota_holds_committed_lte_reserved
    CHECK (committed_count <= reserved_count)
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_quota_holds_idempotency_uidx
  ON lead_quota_holds (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS lead_quota_holds_search_uidx
  ON lead_quota_holds (search_id);
CREATE INDEX IF NOT EXISTS lead_quota_holds_user_period_status_idx
  ON lead_quota_holds (user_id, period_start, status);

CREATE TABLE IF NOT EXISTS fx_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency   CHAR(3) NOT NULL,
  quote_currency  CHAR(3) NOT NULL,
  rate            NUMERIC(18, 8) NOT NULL CHECK (rate > 0),
  rate_date       DATE NOT NULL,
  source          TEXT NOT NULL DEFAULT 'frankfurter',
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (base_currency, quote_currency)
);
CREATE INDEX IF NOT EXISTS fx_rates_fetched_at_idx ON fx_rates (fetched_at DESC);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS external_checkout_id TEXT,
  ADD COLUMN IF NOT EXISTS external_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS checkout_url TEXT,
  ADD COLUMN IF NOT EXISTS fx_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS payments_external_checkout_id_uidx
  ON payments (external_checkout_id)
  WHERE external_checkout_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        TEXT NOT NULL DEFAULT 'payzeno',
  event_id        TEXT NOT NULL,
  event_type      TEXT,
  payment_id      UUID REFERENCES payments(id) ON DELETE SET NULL,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, event_id)
);
