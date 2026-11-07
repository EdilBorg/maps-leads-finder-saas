-- Maps Leads Finder SaaS — Etapa 5 lock ordering via transaction advisory locks
-- Goal: avoid parent/child deadlock cycles under concurrent UPDATE×UPDATE.
-- Global order: always take pg_advisory_xact_lock on the parent entity key first.
-- PostgreSQL 12+. Additive; does not rewrite 001–005.

CREATE OR REPLACE FUNCTION enforce_payment_subscription_same_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  sub_user UUID;
BEGIN
  IF NEW.subscription_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('sub:' || NEW.subscription_id::text));
  SELECT user_id INTO sub_user
  FROM subscriptions
  WHERE id = NEW.subscription_id
  FOR UPDATE;
  IF sub_user IS NULL THEN
    RAISE EXCEPTION 'payment subscription_id % does not exist', NEW.subscription_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF sub_user IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'payment user_id must match subscription.user_id (multi-tenant isolation)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_subscription_user_change_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ref_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    PERFORM pg_advisory_xact_lock(hashtext('sub:' || OLD.id::text));
    PERFORM 1 FROM payments
      WHERE subscription_id = OLD.id
      ORDER BY id
      FOR UPDATE;
    SELECT COUNT(*) INTO ref_count FROM payments WHERE subscription_id = OLD.id;
    IF ref_count > 0 THEN
      RAISE EXCEPTION
        'cannot change subscriptions.user_id while % payment(s) reference this subscription (multi-tenant isolation)',
        ref_count
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_saved_lead_origin_same_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  search_user UUID;
BEGIN
  IF NEW.origin_search_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('search:' || NEW.origin_search_id::text));
  SELECT user_id INTO search_user
  FROM searches
  WHERE id = NEW.origin_search_id
  FOR UPDATE;
  IF search_user IS NULL THEN
    RAISE EXCEPTION 'saved_leads origin_search_id % does not exist', NEW.origin_search_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF search_user IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'saved_leads.user_id must match origin search.user_id (multi-tenant isolation)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_search_user_change_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lead_count INTEGER;
  result_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    PERFORM pg_advisory_xact_lock(hashtext('search:' || OLD.id::text));
    PERFORM 1 FROM saved_leads
      WHERE origin_search_id = OLD.id
      ORDER BY id
      FOR UPDATE;
    SELECT COUNT(*) INTO lead_count
    FROM saved_leads WHERE origin_search_id = OLD.id;
    IF lead_count > 0 THEN
      RAISE EXCEPTION
        'cannot change searches.user_id while % saved_lead(s) reference this search (multi-tenant isolation)',
        lead_count
        USING ERRCODE = 'check_violation';
    END IF;

    PERFORM 1 FROM search_results
      WHERE search_id = OLD.id
      ORDER BY id
      FOR UPDATE;
    SELECT COUNT(*) INTO result_count
    FROM search_results WHERE search_id = OLD.id;
    IF result_count > 0 THEN
      RAISE EXCEPTION
        'cannot change searches.user_id while % search_result(s) belong to this search (multi-tenant isolation)',
        result_count
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_search_result_duplicate_same_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  dup_search UUID;
  dup_user UUID;
BEGIN
  IF NEW.is_duplicate_of IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.is_duplicate_of = NEW.id THEN
    RAISE EXCEPTION 'is_duplicate_of cannot reference the same row'
      USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('result:' || NEW.is_duplicate_of::text));
  SELECT search_id, user_id INTO dup_search, dup_user
  FROM search_results
  WHERE id = NEW.is_duplicate_of
  FOR UPDATE;
  IF dup_search IS NULL THEN
    RAISE EXCEPTION 'is_duplicate_of % does not exist', NEW.is_duplicate_of
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF dup_search IS DISTINCT FROM NEW.search_id OR dup_user IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'is_duplicate_of must reference a result in the same search and user (multi-tenant isolation)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_search_result_scope_change_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  dep_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.search_id IS DISTINCT FROM OLD.search_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
     ) THEN
    PERFORM pg_advisory_xact_lock(hashtext('result:' || OLD.id::text));
    PERFORM 1 FROM search_results
      WHERE is_duplicate_of = OLD.id
      ORDER BY id
      FOR UPDATE;
    SELECT COUNT(*) INTO dep_count
    FROM search_results WHERE is_duplicate_of = OLD.id;
    IF dep_count > 0 THEN
      RAISE EXCEPTION
        'cannot change search_id/user_id of a result while % other result(s) reference it via is_duplicate_of (multi-tenant isolation)',
        dep_count
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_payment_subscription_same_user() IS
  'Same-tenant payment↔subscription; advisory lock sub:<id> then FOR UPDATE parent.';
COMMENT ON FUNCTION enforce_subscription_user_change_safe() IS
  'Blocks subscription owner change with dependents; advisory lock sub:<id> first.';
COMMENT ON FUNCTION enforce_saved_lead_origin_same_user() IS
  'Same-tenant saved_lead↔search; advisory lock search:<id> then FOR UPDATE parent.';
COMMENT ON FUNCTION enforce_search_user_change_safe() IS
  'Blocks search owner change with dependents; advisory lock search:<id> first.';
COMMENT ON FUNCTION enforce_search_result_duplicate_same_scope() IS
  'Same search/user for is_duplicate_of; advisory lock result:<id> then FOR UPDATE target.';
COMMENT ON FUNCTION enforce_search_result_scope_change_safe() IS
  'Blocks moving a result targeted by is_duplicate_of; advisory lock result:<id> first.';
