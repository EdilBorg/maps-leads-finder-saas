-- Correct the legacy backfill from migration 019.
-- processed_at is not evidence of successful webhook processing.
-- Only successful payment events linked to completed payments remain processed.
-- Existing failed events are preserved; all other legacy received/processed
-- events without sufficient evidence become failed.

UPDATE payment_webhook_events e
SET processing_status = CASE
  WHEN LOWER(COALESCE(e.event_type, '')) IN (
    'payment.succeeded',
    'succeeded',
    'paid'
  )
  AND EXISTS (
    SELECT 1
    FROM payments p
    WHERE p.id = e.payment_id
      AND p.status IN ('completed', 'approved')
  )
  THEN 'processed'
  ELSE 'failed'
END
WHERE e.processing_status IN ('received', 'processed');
