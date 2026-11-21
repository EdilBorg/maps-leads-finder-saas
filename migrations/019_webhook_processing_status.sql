-- Distinguish received vs processed webhook events so failed deliveries can retry.
ALTER TABLE payment_webhook_events
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'received';

-- Backfill: existing rows treated as processed (historical).
UPDATE payment_webhook_events
SET processing_status = 'processed'
WHERE processing_status = 'received'
  AND processed_at IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_webhook_events_processing_status_check'
  ) THEN
    ALTER TABLE payment_webhook_events
      ADD CONSTRAINT payment_webhook_events_processing_status_check
      CHECK (processing_status IN ('received', 'processed', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payment_webhook_events_status_idx
  ON payment_webhook_events (processing_status);
