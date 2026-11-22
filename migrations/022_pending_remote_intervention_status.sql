-- Add terminal intervention status for pending remote executions.
-- Reservations remain held until administrative resolution.

ALTER TABLE pending_remote_executions
  DROP CONSTRAINT IF EXISTS pending_remote_executions_status_check;

ALTER TABLE pending_remote_executions
  ADD CONSTRAINT pending_remote_executions_status_check
  CHECK (
    status IN (
      'pending',
      'reconciling',
      'resolved',
      'failed',
      'expired',
      'intervention'
    )
  );

CREATE INDEX IF NOT EXISTS pending_remote_executions_intervention_idx
  ON pending_remote_executions (status, updated_at)
  WHERE status = 'intervention';
