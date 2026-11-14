-- Allow cancelled on searches.status.
--
-- Identifies the single-column status CHECK via catalog metadata
-- (pg_constraint.conkey + pg_attribute), then validates the expression
-- semantically by comparing pg_get_expr(conbin, conrelid) to reference
-- CHECKs created on temporary tables with the exact expected rules.
--
-- This rejects expressions that merely contain the same string literals
-- but add OR TRUE, extra AND conditions, or other semantic differences.
--
-- Expected legacy rule (003_domain_model.sql):
--   CHECK (status IN ('pending','running','completed','partial','failed'))
-- Target rule:
--   CHECK (status IN ('pending','running','completed','partial','failed','cancelled'))

DO $$
DECLARE
  status_attnum   INT;
  matched_count   INT;
  con_name        TEXT;
  actual_expr     TEXT;
  expected_old    TEXT;
  expected_new    TEXT;
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

  SELECT c.conname, pg_get_expr(c.conbin, c.conrelid)
    INTO con_name, actual_expr
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON t.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND t.relname = 'searches'
    AND c.contype = 'c'
    AND c.conkey IS NOT NULL
    AND c.conkey = ARRAY[status_attnum]::int2[];

  -- Reference constraints with the exact expected SQL (same column name "status").
  -- pg_get_expr yields the server-normalized form for reliable comparison.
  CREATE TEMP TABLE _m010_ref_old (
    status text NOT NULL,
    CONSTRAINT _m010_ref_old_chk
      CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed'))
  ) ON COMMIT DROP;

  CREATE TEMP TABLE _m010_ref_new (
    status text NOT NULL,
    CONSTRAINT _m010_ref_new_chk
      CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'))
  ) ON COMMIT DROP;

  SELECT pg_get_expr(c.conbin, c.conrelid)
    INTO expected_old
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = '_m010_ref_old'
    AND c.conname = '_m010_ref_old_chk';

  SELECT pg_get_expr(c.conbin, c.conrelid)
    INTO expected_new
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = '_m010_ref_new'
    AND c.conname = '_m010_ref_new_chk';

  IF expected_old IS NULL OR expected_new IS NULL THEN
    RAISE EXCEPTION
      'migration 010: failed to build reference CHECK expressions for comparison';
  END IF;

  -- Scenario 2: already the legitimate six-state rule → idempotent no-op
  IF actual_expr IS NOT DISTINCT FROM expected_new THEN
    RAISE NOTICE 'migration 010: constraint % already matches the six-state rule — no-op', con_name;
    DROP TABLE IF EXISTS _m010_ref_old;
    DROP TABLE IF EXISTS _m010_ref_new;
    RETURN;
  END IF;

  -- Scenario 1: exact legacy five-state rule → replace
  IF actual_expr IS NOT DISTINCT FROM expected_old THEN
    EXECUTE format('ALTER TABLE public.searches DROP CONSTRAINT %I', con_name);

    ALTER TABLE public.searches
      ADD CONSTRAINT searches_status_check
      CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'));

    RAISE NOTICE 'migration 010: replaced % with searches_status_check (six states)', con_name;
    DROP TABLE IF EXISTS _m010_ref_old;
    DROP TABLE IF EXISTS _m010_ref_new;
    RETURN;
  END IF;

  -- Scenarios 4–6 and any other unexpected expression → fail closed
  RAISE EXCEPTION
    'migration 010: constraint % on searches.status does not match the expected legacy or target expression. actual=% | expected_old=% | expected_new=%',
    con_name, actual_expr, expected_old, expected_new;
END $$;
