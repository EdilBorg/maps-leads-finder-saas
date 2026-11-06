-- Maps Leads Finder SaaS — Etapa 5 integrity fixes
-- Multi-tenant referential integrity for payments, saved_leads, search_results.
-- Compatible with PostgreSQL 12+. Idempotent where possible.
-- Does NOT modify 001–003 files; additive only.

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
      '004 integrity: % payment(s) reference a subscription owned by a different user. Fix data before migrating.',
      bad_payments;
  END IF;

  SELECT COUNT(*) INTO bad_leads
  FROM saved_leads sl
  JOIN searches s ON s.id = sl.origin_search_id
  WHERE sl.origin_search_id IS NOT NULL
    AND sl.user_id IS DISTINCT FROM s.user_id;

  IF bad_leads > 0 THEN
    RAISE EXCEPTION
      '004 integrity: % saved_lead(s) reference a search owned by a different user. Fix data before migrating.',
      bad_leads;
  END IF;

  SELECT COUNT(*) INTO bad_dups
  FROM search_results r
  JOIN search_results d ON d.id = r.is_duplicate_of
  WHERE r.is_duplicate_of IS NOT NULL
    AND (r.user_id IS DISTINCT FROM d.user_id OR r.search_id IS DISTINCT FROM d.search_id);

  IF bad_dups > 0 THEN
    RAISE EXCEPTION
      '004 integrity: % search_result(s) have is_duplicate_of pointing outside the same search/user. Fix data before migrating.',
      bad_dups;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_id_user_unique'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_id_user_unique UNIQUE (id, user_id);
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
  SELECT user_id INTO sub_user FROM subscriptions WHERE id = NEW.subscription_id;
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

DROP TRIGGER IF EXISTS trg_payments_subscription_same_user ON payments;
CREATE TRIGGER trg_payments_subscription_same_user
  BEFORE INSERT OR UPDATE OF subscription_id, user_id
  ON payments
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_payment_subscription_same_user();

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
  SELECT user_id INTO search_user FROM searches WHERE id = NEW.origin_search_id;
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

DROP TRIGGER IF EXISTS trg_saved_leads_origin_same_user ON saved_leads;
CREATE TRIGGER trg_saved_leads_origin_same_user
  BEFORE INSERT OR UPDATE OF origin_search_id, user_id
  ON saved_leads
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_saved_lead_origin_same_user();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'search_results_no_self_duplicate_chk'
  ) THEN
    ALTER TABLE search_results
      ADD CONSTRAINT search_results_no_self_duplicate_chk
      CHECK (is_duplicate_of IS NULL OR is_duplicate_of IS DISTINCT FROM id);
  END IF;
END $$;

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
  FROM search_results WHERE id = NEW.is_duplicate_of;
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

DROP TRIGGER IF EXISTS trg_search_results_duplicate_scope ON search_results;
CREATE TRIGGER trg_search_results_duplicate_scope
  BEFORE INSERT OR UPDATE OF is_duplicate_of, search_id, user_id
  ON search_results
  FOR EACH ROW
  EXECUTE PROCEDURE enforce_search_result_duplicate_same_scope();

COMMENT ON FUNCTION enforce_payment_subscription_same_user() IS
  'Ensures payments.user_id matches subscriptions.user_id when subscription_id is set.';
COMMENT ON FUNCTION enforce_saved_lead_origin_same_user() IS
  'Ensures saved_leads.user_id matches searches.user_id for origin_search_id.';
COMMENT ON FUNCTION enforce_search_result_duplicate_same_scope() IS
  'Ensures is_duplicate_of points to a result in the same search_id and user_id.';
