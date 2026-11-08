-- Link free-search hold to the search row for safe abandonment recovery.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS free_search_hold_search_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_free_search_hold_search_id_fkey'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_free_search_hold_search_id_fkey
      FOREIGN KEY (free_search_hold_search_id) REFERENCES searches(id) ON DELETE SET NULL;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    NULL;
END $$;

CREATE INDEX IF NOT EXISTS users_free_search_hold_search_id_idx
  ON users (free_search_hold_search_id)
  WHERE free_search_hold_search_id IS NOT NULL;
