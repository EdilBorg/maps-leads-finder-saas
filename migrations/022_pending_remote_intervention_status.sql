-- Add terminal 'intervention' status for pending remote executions that exceeded
-- MAX_ATTEMPTS without a confirmed remote outcome. Reservation stays held;
-- workers must not reclaim these rows. Administrative resolution is external.

-- Drop and recreate status CHECK to include intervention
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'c'
      AND c.conrelid = 'pending_remote_executions'::regclass
      AND a.attname = 'status'
  LOOP
    EXECUTE format('ALTER TABLE pending_remote_executions DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE pending_remote_executions
  ADD CONSTRAINT pending_remote_executions_status_check
  CHECK (status IN ('pending', 'reconciling', 'resolved', 'failed', 'expired', 'intervention'));

-- Index for admin listing of intervention rows (not claimed by workers)
CREATE INDEX IF NOT EXISTS pending_remote_executions_intervention_idx
  ON pending_remote_executions (status, updated_at)
  WHERE status = 'intervention';
