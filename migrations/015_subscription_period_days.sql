-- Immutable per-subscription cycle length (days). Does not alter historical rows' behaviour
-- beyond defaulting existing rows to 30. New activations write the resolved value explicitly.
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS period_days INTEGER;

UPDATE subscriptions
SET period_days = 30
WHERE period_days IS NULL;

ALTER TABLE subscriptions
  ALTER COLUMN period_days SET DEFAULT 30;

ALTER TABLE subscriptions
  ALTER COLUMN period_days SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_period_days_chk'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_period_days_chk
      CHECK (period_days > 0 AND period_days <= 366);
  END IF;
END $$;

-- Optional ledger for global TomTom reserve/commit idempotency (no user_id required)
CREATE TABLE IF NOT EXISTS provider_global_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_code TEXT NOT NULL CHECK (provider_code IN ('tomtom')),
  event_type TEXT NOT NULL CHECK (event_type IN ('reserve', 'commit', 'release')),
  period_start TIMESTAMPTZ NOT NULL,
  calls_delta INTEGER NOT NULL DEFAULT 0,
  search_id UUID REFERENCES searches(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_global_usage_events_idempotency_uidx
  ON provider_global_usage_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS provider_global_usage_events_period_idx
  ON provider_global_usage_events (provider_code, period_start);
