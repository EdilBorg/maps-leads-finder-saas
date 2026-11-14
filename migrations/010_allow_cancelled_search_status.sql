-- Allow cancelled on searches.status.
-- Identifies the CHECK constraint via PostgreSQL catalog metadata
-- (pg_constraint.conkey + pg_attribute), not by name or free-text heuristics.
--
-- Expected prior rule (from 003_domain_model.sql):
--   CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed'))
-- Target rule:
--   CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'))
--
-- Fail closed: if the expected single-column status CHECK is missing or unexpected,
-- raise an exception. Never invent a constraint when the schema does not match.

DO $$
DECLARE
  status_attnum   INT;
  matched_count   INT;
  con_name        TEXT;
  con_def         TEXT;
  literal_count   INT;
  has_pending     BOOLEAN;
  has_running     BOOLEAN;
  has_completed   BOOLEAN;
  has_partial     BOOLEAN;
  has_failed      BOOLEAN;
  has_cancelled   BOOLEAN;
BEGIN
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

  -- CHECK constraints that reference ONLY the status column
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
    RAISE EXCEPTION
      'migration 010: no CHECK constraint found that applies only to public.searches.status — refusing to invent one';
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

  has_pending   := con_def ~* '''pending''';
  has_running   := con_def ~* '''running''';
  has_completed := con_def ~* '''completed''';
  has_partial   := con_def ~* '''partial''';
  has_failed    := con_def ~* '''failed''';
  has_cancelled := con_def ~* '''cancelled''';

  -- Idempotent: already the six-state rule
  IF has_pending AND has_running AND has_completed AND has_partial AND has_failed AND has_cancelled THEN
    SELECT COUNT(*) INTO literal_count
    FROM regexp_matches(con_def, '''([^'']+)''', 'g') AS m(x);
    IF literal_count = 6 THEN
      RAISE NOTICE 'migration 010: constraint % already allows the six expected statuses — no-op', con_name;
      RETURN;
    END IF;
    -- Has cancelled plus extras → unexpected
    RAISE EXCEPTION
      'migration 010: constraint % on searches.status has cancelled but unexpected extra literals (% found): %',
      con_name, literal_count, con_def;
  END IF;

  -- Legacy expected rule: exactly the five original statuses, no cancelled
  SELECT COUNT(*) INTO literal_count
  FROM regexp_matches(con_def, '''([^'']+)''', 'g') AS m(x);

  IF NOT (has_pending AND has_running AND has_completed AND has_partial AND has_failed)
     OR has_cancelled
     OR literal_count <> 5
  THEN
    RAISE EXCEPTION
      'migration 010: constraint % on searches.status is not the expected legacy rule (five statuses, no cancelled). def=%',
      con_name, con_def;
  END IF;

  EXECUTE format('ALTER TABLE public.searches DROP CONSTRAINT %I', con_name);

  ALTER TABLE public.searches
    ADD CONSTRAINT searches_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'));

  RAISE NOTICE 'migration 010: replaced % with searches_status_check including cancelled', con_name;
END $$;
