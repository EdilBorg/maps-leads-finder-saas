-- Maps Leads Finder SaaS — Etapa 5 update-path & concurrency integrity
-- Protects multi-tenant invariants when REFERENCED rows are UPDATED,
-- and hardens child triggers with row locks against concurrent races.
-- PostgreSQL 12+. Additive; does not alter 001–004 file history.

DO $$
DECLARE
  bad_payments INTEGER;
  bad_leads INTEGER;
  bad_dups INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_payments
  FROM payments p
  JOIN subscriptions s ON s.id = p.subscription_id
  WHERE p.subscription_id IS NOT NULL
    AND p.user_id IS DISTINCT FROM s.user_id;
  IF bad_payments > 0 THEN
    RAISE EXCEPTION
      '005 integrity: % payment(s) reference a subscription of a different user.',
      bad_payments;
  END IF;

  SELECT COUNT(*) INTO bad_leads
  FROM saved_leads sl
  JOIN searches s ON s.id = sl.origin_search_id
  WHERE sl.origin_search_id IS NOT NULL
    AND sl.user_id IS DISTINCT FROM s.user_id;
  IF bad_leads > 0 THEN
    RAISE EXCEPTION
      '005 integrity: % saved_lead(s) reference a search of a different user.',
      bad_leads;
  END IF;

  SELECT COUNT(*) INTO bad_dups
  FROM search_results r
  JOIN search_results d ON d.id = r.is_duplicate_of
  WHERE r.is_duplicate_of IS NOT NULL
    AND (r.user_id IS DISTINCT FROM d.user_id OR r.search_id IS DISTINCT FROM d.search_id);
  IF bad_dups > 0 THEN
    RAISE EXCEPTION
      '005 integrity: % search_result(s) have cross-scope is_duplicate_of.',
      bad_dups;
  END IF;
END $$;

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

DROP TRIGGER IF EXISTS trg_payments_subscription_same_user ON payments;
CREATE TRIGGER trg_payments_subscription_same_user
  BEFORE INSERT OR UPDATE OF subscription_id, user_id
  ON payments
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_payment_subscription_same_user();

DROP TRIGGER IF EXISTS trg_saved_leads_origin_same_user ON saved_leads;
CREATE TRIGGER trg_saved_leads_origin_same_user
  BEFORE INSERT OR UPDATE OF origin_search_id, user_id
  ON saved_leads
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_saved_lead_origin_same_user();

DROP TRIGGER IF EXISTS trg_search_results_duplicate_scope ON search_results;
CREATE TRIGGER trg_search_results_duplicate_scope
  BEFORE INSERT OR UPDATE OF is_duplicate_of, search_id, user_id
  ON search_results
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_search_result_duplicate_same_scope();

CREATE OR REPLACE FUNCTION enforce_subscription_user_change_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  ref_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
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

DROP TRIGGER IF EXISTS trg_subscriptions_user_change_safe ON subscriptions;
CREATE TRIGGER trg_subscriptions_user_change_safe
  BEFORE UPDATE OF user_id
  ON subscriptions
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_subscription_user_change_safe();

CREATE OR REPLACE FUNCTION enforce_search_user_change_safe()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  lead_count INTEGER;
  result_count INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
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

DROP TRIGGER IF EXISTS trg_searches_user_change_safe ON searches;
CREATE TRIGGER trg_searches_user_change_safe
  BEFORE UPDATE OF user_id
  ON searches
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_search_user_change_safe();

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

DROP TRIGGER IF EXISTS trg_search_results_scope_change_safe ON search_results;
CREATE TRIGGER trg_search_results_scope_change_safe
  BEFORE UPDATE OF search_id, user_id
  ON search_results
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_search_result_scope_change_safe();

COMMENT ON FUNCTION enforce_subscription_user_change_safe() IS
  'Blocks subscriptions.user_id changes when payments reference the row; locks payments FOR UPDATE.';
COMMENT ON FUNCTION enforce_search_user_change_safe() IS
  'Blocks searches.user_id changes when saved_leads or search_results reference the search.';
COMMENT ON FUNCTION enforce_search_result_scope_change_safe() IS
  'Blocks search_results search_id/user_id changes when other rows reference is_duplicate_of.';
