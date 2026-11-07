-- Atomic free-search hold (no long-lived transaction during external provider calls).
-- free_search_used remains the permanent consumption flag.
-- A hold is a short-lived reservation token that expires and can be reclaimed.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS free_search_hold_token UUID NULL,
  ADD COLUMN IF NOT EXISTS free_search_hold_until TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS users_free_search_hold_until_idx
  ON users (free_search_hold_until)
  WHERE free_search_hold_token IS NOT NULL;
