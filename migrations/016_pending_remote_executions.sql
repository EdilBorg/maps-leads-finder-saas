-- Persist remote provider executions that may still incur cost after local cancel/fail.
-- Reservations stay held until reconciliation commits actual usage or confirms zero cost.

CREATE TABLE IF NOT EXISTS pending_remote_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  search_id UUID REFERENCES searches(id) ON DELETE SET NULL,
  provider_code TEXT NOT NULL CHECK (provider_code IN ('apify', 'brightdata')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'reconciling', 'resolved', 'failed', 'expired')),
  external_run_id TEXT,
  period_start TIMESTAMPTZ NOT NULL,
  reserved_results INTEGER NOT NULL DEFAULT 0 CHECK (reserved_results >= 0),
  reserved_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (reserved_cost_micro_usd >= 0),
  reserved_api_calls INTEGER NOT NULL DEFAULT 0 CHECK (reserved_api_calls >= 0),
  unit_cost_micro_usd BIGINT,
  fixed_execution_cost_micro_usd BIGINT,
  include_fixed_cost BOOLEAN NOT NULL DEFAULT FALSE,
  pricing_version TEXT,
  actual_results INTEGER,
  actual_cost_micro_usd BIGINT,
  actual_api_calls INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS pending_remote_executions_status_next_idx
  ON pending_remote_executions (status, next_attempt_at)
  WHERE status IN ('pending', 'reconciling');

CREATE INDEX IF NOT EXISTS pending_remote_executions_search_idx
  ON pending_remote_executions (search_id)
  WHERE search_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pending_remote_executions_search_provider_uidx
  ON pending_remote_executions (search_id, provider_code)
  WHERE search_id IS NOT NULL AND status IN ('pending', 'reconciling');
