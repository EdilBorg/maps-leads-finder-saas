-- Allow cancelled status on searches (required for user-initiated cancel).
-- Only drop the CHECK constraint that validates the status column values.
-- Inline CHECKs from CREATE TABLE appear as searches_status_check in PostgreSQL
-- when named; unnamed ones are matched by definition containing status IN (...).

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE t.relname = 'searches'
      AND n.nspname = 'public'
      AND c.contype = 'c'
      AND (
        c.conname = 'searches_status_check'
        OR (
          pg_get_constraintdef(c.oid) ~* 'status'
          AND pg_get_constraintdef(c.oid) ~* '\mIN\s*\('
          AND pg_get_constraintdef(c.oid) ~* 'pending'
          AND pg_get_constraintdef(c.oid) ~* 'running'
        )
      )
  LOOP
    -- Skip if this constraint already allows cancelled
    IF r.def ILIKE '%cancelled%' THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE searches DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

-- Add named constraint only if no status CHECK currently allows cancelled
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE t.relname = 'searches'
      AND n.nspname = 'public'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%cancelled%'
      AND pg_get_constraintdef(c.oid) ~* 'status'
  ) THEN
    ALTER TABLE searches
      ADD CONSTRAINT searches_status_check
      CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'));
  END IF;
END $$;
