-- Concurrency control for pending remote execution reconciler workers.
ALTER TABLE pending_remote_executions
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS pending_remote_executions_lease_idx
  ON pending_remote_executions (status, next_attempt_at, lease_expires_at)
  WHERE status IN ('pending', 'reconciling');
