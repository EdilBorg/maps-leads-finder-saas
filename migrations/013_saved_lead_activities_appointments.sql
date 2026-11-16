-- CRM Stage 2: activity history + per-lead appointments
-- Non-destructive. Does not alter existing saved_leads columns or data.

-- ---------------------------------------------------------------------------
-- Activities (manual contacts + automatic status_change events)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_lead_activities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id         UUID NOT NULL REFERENCES saved_leads(id) ON DELETE CASCADE,
  activity_type   TEXT NOT NULL
                    CHECK (activity_type IN (
                      'phone_call',
                      'whatsapp',
                      'meeting',
                      'other',
                      'status_change'
                    )),
  description     TEXT NOT NULL,
  outcome         TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL,
  from_status     TEXT,
  to_status       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT saved_lead_activities_status_pair CHECK (
    (
      activity_type = 'status_change'
      AND from_status IS NOT NULL
      AND to_status IS NOT NULL
    )
    OR (
      activity_type <> 'status_change'
      AND from_status IS NULL
      AND to_status IS NULL
    )
  ),
  CONSTRAINT saved_lead_activities_description_len CHECK (
    char_length(description) >= 1 AND char_length(description) <= 5000
  ),
  CONSTRAINT saved_lead_activities_outcome_len CHECK (
    outcome IS NULL OR char_length(outcome) <= 2000
  )
);

CREATE INDEX IF NOT EXISTS saved_lead_activities_user_lead_occurred_idx
  ON saved_lead_activities (user_id, lead_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS saved_lead_activities_user_occurred_idx
  ON saved_lead_activities (user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS saved_lead_activities_lead_id_idx
  ON saved_lead_activities (lead_id);

-- Multi-tenant integrity: activity.user_id must match lead.user_id
CREATE OR REPLACE FUNCTION trg_fn_saved_lead_activities_same_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lead_owner UUID;
BEGIN
  SELECT user_id INTO lead_owner FROM saved_leads WHERE id = NEW.lead_id;
  IF lead_owner IS NULL THEN
    RAISE EXCEPTION 'saved_lead_activities.lead_id % does not exist', NEW.lead_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF lead_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'saved_lead_activities.user_id must match saved_leads.user_id (multi-tenant isolation)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_saved_lead_activities_same_user ON saved_lead_activities;
CREATE TRIGGER trg_saved_lead_activities_same_user
  BEFORE INSERT OR UPDATE OF user_id, lead_id
  ON saved_lead_activities
  FOR EACH ROW
  EXECUTE PROCEDURE trg_fn_saved_lead_activities_same_user();

-- ---------------------------------------------------------------------------
-- Appointments (independent of commercial lead status)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_lead_appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id         UUID NOT NULL REFERENCES saved_leads(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT saved_lead_appointments_title_len CHECK (
    char_length(btrim(title)) >= 1 AND char_length(title) <= 200
  ),
  CONSTRAINT saved_lead_appointments_description_len CHECK (
    description IS NULL OR char_length(description) <= 5000
  )
);

CREATE INDEX IF NOT EXISTS saved_lead_appointments_user_lead_scheduled_idx
  ON saved_lead_appointments (user_id, lead_id, scheduled_at ASC);

CREATE INDEX IF NOT EXISTS saved_lead_appointments_user_scheduled_idx
  ON saved_lead_appointments (user_id, scheduled_at ASC);

CREATE INDEX IF NOT EXISTS saved_lead_appointments_user_status_scheduled_idx
  ON saved_lead_appointments (user_id, status, scheduled_at ASC);

CREATE INDEX IF NOT EXISTS saved_lead_appointments_lead_id_idx
  ON saved_lead_appointments (lead_id);

CREATE OR REPLACE FUNCTION trg_fn_saved_lead_appointments_same_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lead_owner UUID;
BEGIN
  SELECT user_id INTO lead_owner FROM saved_leads WHERE id = NEW.lead_id;
  IF lead_owner IS NULL THEN
    RAISE EXCEPTION 'saved_lead_appointments.lead_id % does not exist', NEW.lead_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF lead_owner IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'saved_lead_appointments.user_id must match saved_leads.user_id (multi-tenant isolation)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_saved_lead_appointments_same_user ON saved_lead_appointments;
CREATE TRIGGER trg_saved_lead_appointments_same_user
  BEFORE INSERT OR UPDATE OF user_id, lead_id
  ON saved_lead_appointments
  FOR EACH ROW
  EXECUTE PROCEDURE trg_fn_saved_lead_appointments_same_user();
