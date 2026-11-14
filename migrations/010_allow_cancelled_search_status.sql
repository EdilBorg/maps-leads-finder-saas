-- Allow cancelled on searches.status.
-- Identifies the CHECK constraint via PostgreSQL catalog metadata
-- (pg_constraint + pg_attribute), not by name heuristics or free-text matching.
--
-- Expected prior rule (from 003_domain_model.sql):
--   CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed'))
-- Target rule:
--   CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'))

DO $$
DECLARE
  status_attnum  INT;
  matched_count  INT;
  con_name       TEXT;
  con_def        TEXT;
  already_ok     BOOLEAN := FALSE;
BEGIN
  -- Resolve the attribute number of public.searches.status
  SELECT a.attnum
    INTO status_attnum
  FROM pg_attribute a
  JOIN pg_class t ON a.attrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND t.relname = 'searches'
    AND a.attname = 'status'
    AND NOT a.attisdropped;

  IF status_attnum IS NULL THEN
    RAISE EXCEPTION
      'migration 010: column public.searches.status not found — refusing to modify constraints';
  END IF;

  -- CHECK constraints that reference ONLY the status column (conkey = {status_attnum})
  SELECT COUNT(*)
    INTO matched_count
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND t.relname = 'searches'
    AND c.contype = 'c'
    AND c.conkey IS NOT NULL
    AND c.conkey = ARRAY[status_attnum]::int2[];

  IF matched_count = 0 THEN
    -- No single-column status CHECK: either already migrated under another shape, or schema drift.
    -- If any status-only CHECK already allows cancelled, treat as done.
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      WHERE n.nspname = 'public'
        AND t.relname = 'searches'
        AND c.contype = 'c'
        AND c.conkey IS NOT NULL
        AND c.conkey = ARRAY[status_attnum]::int2[]
        AND pg_get_constraintdef(c.oid) ILIKE '%cancelled%'
    ) INTO already_ok;

    IF already_ok THEN
      RAISE NOTICE 'migration 010: status CHECK already allows cancelled — no-op';
      RETURN;
    END IF;

    -- Add the named constraint if none exists on status alone
    ALTER TABLE public.searches
      ADD CONSTRAINT searches_status_check
      CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'));
    RAISE NOTICE 'migration 010: added searches_status_check (no prior status-only CHECK found)';
    RETURN;
  END IF;

  IF matched_count > 1 THEN
    RAISE EXCEPTION
      'migration 010: found % CHECK constraints on public.searches.status alone — refusing ambiguous drop',
      matched_count;
  END IF;

  SELECT c.conname, pg_get_constraintdef(c.oid)
    INTO con_name, con_def
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND t.relname = 'searches'
    AND c.contype = 'c'
    AND c.conkey IS NOT NULL
    AND c.conkey = ARRAY[status_attnum]::int2[];

  -- Already allows cancelled → idempotent no-op
  IF con_def ILIKE '%cancelled%' THEN
    RAISE NOTICE 'migration 010: constraint % already allows cancelled — no-op', con_name;
    RETURN;
  END IF;

  -- Sanity: expected legacy rule mentions the five original states
  IF con_def IS NULL
     OR con_def !~* 'pending'
     OR con_def !~* 'running'
     OR con_def !~* 'completed'
  THEN
    RAISE EXCEPTION
      'migration 010: constraint % on searches.status has unexpected definition: % — refusing to drop',
      con_name, con_def;
  END IF;

  EXECUTE format('ALTER TABLE public.searches DROP CONSTRAINT %I', con_name);

  ALTER TABLE public.searches
    ADD CONSTRAINT searches_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'));

  RAISE NOTICE 'migration 010: replaced % with searches_status_check including cancelled', con_name;
END $$;
