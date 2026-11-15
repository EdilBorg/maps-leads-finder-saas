-- CRM Stage 1: commercial status on saved_leads
-- Preserves all existing columns and data. Idempotent where practical.

ALTER TABLE saved_leads
  ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE saved_leads
SET status = 'Por contactar'
WHERE status IS NULL OR btrim(status) = '';

ALTER TABLE saved_leads
  ALTER COLUMN status SET DEFAULT 'Por contactar';

ALTER TABLE saved_leads
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'saved_leads_status_check'
  ) THEN
    ALTER TABLE saved_leads
      ADD CONSTRAINT saved_leads_status_check
      CHECK (status IN (
        'Por contactar',
        'Contactado',
        'Não atendeu',
        'Aguardando resposta',
        'Interessado',
        'Reunião agendada',
        'Não interessado',
        'Cliente'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS saved_leads_user_status_idx
  ON saved_leads (user_id, status);

CREATE INDEX IF NOT EXISTS saved_leads_user_category_idx
  ON saved_leads (user_id, category);
