-- Safe fix for environments where 001_auth.sql failed on session CREATE
-- because of WITH (OIDS=FALSE) on PostgreSQL 12+.
-- Idempotent: does not drop users or existing session rows.

CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key  TEXT PRIMARY KEY,
  hit_count   INT NOT NULL DEFAULT 0,
  reset_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_reset_idx ON rate_limit_buckets (reset_at);
