-- Phase 1: DataForSEO as active provider + TomTom Discover global quota (5000/calendar month UTC).
-- Incremental only. Does not edit previous migrations. Preserves historical apify/brightdata data.

-- ---------------------------------------------------------------------------
-- Helper: drop CHECK constraint on column if present (anonymous or named)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass AS tbl
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'c'
      AND a.attname = 'provider_code'
      AND c.conrelid::regclass::text IN (
        'plan_provider_limits',
        'provider_usage',
        'provider_usage_events',
        'provider_pricing',
        'pending_remote_executions'
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Expand provider_code CHECKs (keep historical apify/brightdata)
-- ---------------------------------------------------------------------------
ALTER TABLE plan_provider_limits
  ADD CONSTRAINT plan_provider_limits_provider_code_check
  CHECK (provider_code IN ('apify', 'brightdata', 'tomtom', 'dataforseo'));

ALTER TABLE provider_usage
  ADD CONSTRAINT provider_usage_provider_code_check
  CHECK (provider_code IN ('apify', 'brightdata', 'tomtom', 'dataforseo'));

ALTER TABLE provider_usage_events
  ADD CONSTRAINT provider_usage_events_provider_code_check
  CHECK (provider_code IN ('apify', 'brightdata', 'tomtom', 'dataforseo'));

ALTER TABLE provider_pricing
  ADD CONSTRAINT provider_pricing_provider_code_check
  CHECK (provider_code IN ('apify', 'brightdata', 'tomtom', 'dataforseo'));

ALTER TABLE pending_remote_executions
  ADD CONSTRAINT pending_remote_executions_provider_code_check
  CHECK (provider_code IN ('apify', 'brightdata', 'dataforseo'));

-- provider_global_usage / provider_global_usage_events remain tomtom-only (Discover quota).

-- ---------------------------------------------------------------------------
-- 2. Seed pricing for dataforseo
-- ---------------------------------------------------------------------------
INSERT INTO provider_pricing (provider_code, pricing_version, unit_cost_micro_usd, fixed_execution_cost_micro_usd, notes)
VALUES ('dataforseo', 'estimate-v1', 0, 0, 'Charged by DataForSEO on task_post; internal ledger optional')
ON CONFLICT (provider_code, pricing_version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. TomTom global Discover quota: 5000 per calendar month UTC
-- ---------------------------------------------------------------------------
INSERT INTO system_settings (key, value) VALUES
  (
    'tomtom_global_quota',
    jsonb_build_object(
      'max_calls_per_period', 5000,
      'period_mode', 'calendar_month_utc',
      'period_days', NULL,
      'note', 'Discover calls only. Geocoding is separate and must not consume this quota.'
    )
  )
ON CONFLICT (key) DO UPDATE SET
  value = jsonb_build_object(
    'max_calls_per_period', 5000,
    'period_mode', 'calendar_month_utc',
    'period_days', NULL,
    'note', 'Discover calls only. Geocoding is separate and must not consume this quota.'
  ),
  updated_at = NOW();
