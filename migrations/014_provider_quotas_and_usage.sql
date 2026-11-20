-- Plans quotas, provider usage ledger, global TomTom usage, pricing versions.
CREATE TABLE IF NOT EXISTS plan_provider_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('apify', 'brightdata', 'tomtom')),
  max_results_per_period INTEGER CHECK (max_results_per_period IS NULL OR max_results_per_period >= 0),
  max_cost_micro_usd_per_period BIGINT CHECK (max_cost_micro_usd_per_period IS NULL OR max_cost_micro_usd_per_period >= 0),
  max_api_calls_per_period INTEGER CHECK (max_api_calls_per_period IS NULL OR max_api_calls_per_period >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT plan_provider_limits_plan_provider_uidx UNIQUE (plan_id, provider_code)
);
CREATE INDEX IF NOT EXISTS plan_provider_limits_plan_id_idx ON plan_provider_limits (plan_id);

CREATE TABLE IF NOT EXISTS provider_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('apify', 'brightdata', 'tomtom')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  results_used INTEGER NOT NULL DEFAULT 0 CHECK (results_used >= 0),
  results_reserved INTEGER NOT NULL DEFAULT 0 CHECK (results_reserved >= 0),
  cost_micro_usd_used BIGINT NOT NULL DEFAULT 0 CHECK (cost_micro_usd_used >= 0),
  cost_micro_usd_reserved BIGINT NOT NULL DEFAULT 0 CHECK (cost_micro_usd_reserved >= 0),
  api_calls_used INTEGER NOT NULL DEFAULT 0 CHECK (api_calls_used >= 0),
  api_calls_reserved INTEGER NOT NULL DEFAULT 0 CHECK (api_calls_reserved >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_usage_period_chk CHECK (period_end > period_start),
  CONSTRAINT provider_usage_user_provider_period_uidx UNIQUE (user_id, provider_code, period_start)
);
CREATE INDEX IF NOT EXISTS provider_usage_user_period_idx ON provider_usage (user_id, period_start DESC);

CREATE TABLE IF NOT EXISTS provider_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  search_id UUID REFERENCES searches(id) ON DELETE SET NULL,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('apify', 'brightdata', 'tomtom')),
  event_type TEXT NOT NULL CHECK (event_type IN ('reserve', 'commit', 'release', 'adjust', 'excess')),
  results_delta INTEGER NOT NULL DEFAULT 0,
  api_calls_delta INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd_delta BIGINT NOT NULL DEFAULT 0,
  excess_results INTEGER NOT NULL DEFAULT 0 CHECK (excess_results >= 0),
  excess_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (excess_cost_micro_usd >= 0),
  idempotency_key TEXT,
  pricing_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_usage_events_idempotency_uidx ON provider_usage_events (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_usage_events_user_created_idx ON provider_usage_events (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_global_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code TEXT NOT NULL CHECK (provider_code IN ('tomtom')),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  calls_used INTEGER NOT NULL DEFAULT 0 CHECK (calls_used >= 0),
  calls_reserved INTEGER NOT NULL DEFAULT 0 CHECK (calls_reserved >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_global_usage_period_chk CHECK (period_end > period_start),
  CONSTRAINT provider_global_usage_provider_period_uidx UNIQUE (provider_code, period_start)
);

CREATE TABLE IF NOT EXISTS provider_pricing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code TEXT NOT NULL CHECK (provider_code IN ('apify', 'brightdata', 'tomtom')),
  pricing_version TEXT NOT NULL,
  unit_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (unit_cost_micro_usd >= 0),
  fixed_execution_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (fixed_execution_cost_micro_usd >= 0),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_pricing_version_uidx UNIQUE (provider_code, pricing_version),
  CONSTRAINT provider_pricing_window_chk CHECK (effective_until IS NULL OR effective_until > effective_from)
);

INSERT INTO provider_pricing (provider_code, pricing_version, unit_cost_micro_usd, fixed_execution_cost_micro_usd, notes) VALUES
  ('apify', 'estimate-v1', 4000, 0, 'Internal estimate only'),
  ('brightdata', 'estimate-v1', 1500, 0, 'Internal estimate only'),
  ('tomtom', 'estimate-v1', 0, 0, 'Shared free-tier oriented')
ON CONFLICT (provider_code, pricing_version) DO NOTHING;

INSERT INTO system_settings (key, value) VALUES
  ('tomtom_global_quota', '{"max_calls_per_period": null, "period_days": 30, "note": "Set max_calls_per_period only when confirmed"}'::jsonb),
  ('subscription_period_days', '{"days": 30}'::jsonb)
ON CONFLICT (key) DO NOTHING;
