-- Maps Leads Finder SaaS — Domain model (Etapa 5)
-- Incremental: does not recreate users, session, or auth token tables.
-- Multi-tenant isolation via mandatory user_id FKs and composite FKs on search_results.

CREATE TABLE IF NOT EXISTS plans (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  description           TEXT,
  price_cents           INTEGER NOT NULL CHECK (price_cents >= 0),
  currency              CHAR(3) NOT NULL DEFAULT 'USD',
  max_searches_per_month INTEGER NOT NULL CHECK (max_searches_per_month >= 0),
  max_results_per_month  INTEGER NOT NULL CHECK (max_results_per_month >= 0),
  max_results_per_search INTEGER NOT NULL CHECK (max_results_per_search > 0),
  features              JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS plans_name_uidx ON plans (name);

CREATE TABLE IF NOT EXISTS subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id         UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('active', 'expired', 'cancelled', 'pending')),
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual', 'gateway')),
  external_ref    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscriptions_ends_after_starts_chk
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS subscriptions_user_id_idx ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS subscriptions_user_status_idx ON subscriptions (user_id, status);
CREATE INDEX IF NOT EXISTS subscriptions_plan_id_idx ON subscriptions (plan_id);

CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id   UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan_id           UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency          CHAR(3) NOT NULL DEFAULT 'USD',
  method            TEXT NOT NULL DEFAULT 'manual'
                      CHECK (method IN ('manual', 'gateway')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'failed')),
  reference         TEXT,
  proof_url         TEXT,
  gateway_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key   TEXT,
  reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_uidx
  ON payments (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_user_id_idx ON payments (user_id);
CREATE INDEX IF NOT EXISTS payments_user_status_idx ON payments (user_id, status);
CREATE INDEX IF NOT EXISTS payments_subscription_id_idx ON payments (subscription_id);

CREATE TABLE IF NOT EXISTS searches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  query               TEXT NOT NULL,
  location            TEXT,
  filters             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed')),
  providers_used      JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_raw           INTEGER NOT NULL DEFAULT 0 CHECK (total_raw >= 0),
  total_normalized    INTEGER NOT NULL DEFAULT 0 CHECK (total_normalized >= 0),
  total_after_dedup   INTEGER NOT NULL DEFAULT 0 CHECK (total_after_dedup >= 0),
  total_after_filters INTEGER NOT NULL DEFAULT 0 CHECK (total_after_filters >= 0),
  error_summary       TEXT,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT searches_id_user_unique UNIQUE (id, user_id)
);

CREATE INDEX IF NOT EXISTS searches_user_id_idx ON searches (user_id);
CREATE INDEX IF NOT EXISTS searches_user_created_idx ON searches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS searches_expires_at_idx ON searches (expires_at)
  WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS searches_status_idx ON searches (status);

CREATE TABLE IF NOT EXISTS search_results (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id         UUID NOT NULL,
  user_id           UUID NOT NULL,
  name              TEXT,
  address           TEXT,
  phone             TEXT,
  email             TEXT,
  website           TEXT,
  rating            NUMERIC(3, 2),
  reviews_count     INTEGER CHECK (reviews_count IS NULL OR reviews_count >= 0),
  category          TEXT,
  lat               DOUBLE PRECISION,
  lng               DOUBLE PRECISION,
  source_provider   TEXT NOT NULL,
  external_id       TEXT,
  raw_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_duplicate_of   UUID REFERENCES search_results(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT search_results_search_user_fk
    FOREIGN KEY (search_id, user_id)
    REFERENCES searches (id, user_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS search_results_search_id_idx ON search_results (search_id);
CREATE INDEX IF NOT EXISTS search_results_user_id_idx ON search_results (user_id);
CREATE INDEX IF NOT EXISTS search_results_user_search_idx ON search_results (user_id, search_id);
CREATE UNIQUE INDEX IF NOT EXISTS search_results_dedup_uidx
  ON search_results (search_id, source_provider, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS saved_leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin_search_id    UUID,
  origin_result_id    UUID,
  name                TEXT,
  address             TEXT,
  phone               TEXT,
  email               TEXT,
  website             TEXT,
  rating              NUMERIC(3, 2),
  reviews_count       INTEGER CHECK (reviews_count IS NULL OR reviews_count >= 0),
  category            TEXT,
  lat                 DOUBLE PRECISION,
  lng                 DOUBLE PRECISION,
  source_provider     TEXT,
  external_id         TEXT,
  snapshot            JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT saved_leads_origin_search_fk
    FOREIGN KEY (origin_search_id)
    REFERENCES searches (id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS saved_leads_user_id_idx ON saved_leads (user_id);
CREATE INDEX IF NOT EXISTS saved_leads_user_created_idx ON saved_leads (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS api_providers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  is_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  rate_limits   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS api_providers_code_uidx ON api_providers (code);

CREATE TABLE IF NOT EXISTS audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  action          TEXT NOT NULL,
  entity_type     TEXT,
  entity_id       TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip              TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
