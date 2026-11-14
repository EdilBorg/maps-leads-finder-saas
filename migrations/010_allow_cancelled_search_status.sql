-- Allow cancelled status on searches (required for user-initiated cancel).
-- Drop any existing status check constraint on searches and recreate with cancelled.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE t.relname = 'searches'
      AND n.nspname = 'public'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE searches DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE searches
  ADD CONSTRAINT searches_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'));
