-- Maps Leads Finder SaaS — Etapa 5 tenant lock helpers + strategy notes
--
-- PROBLEM: BEFORE ROW triggers run *after* PostgreSQL has already taken the
-- exclusive lock on the updated row. Advisory locks inside triggers therefore
-- cannot reorder relative to that implicit row lock. Concurrent:
--   T1: UPDATE payment   (locks payment row)  then wants subscription
--   T2: UPDATE subscription (locks subscription) then wants payments
-- can still deadlock (SQLSTATE 40P01) even with pg_advisory_xact_lock in triggers.
--
-- STRATEGY:
-- 1) Application transactions MUST call lock helpers (or equivalent SQL below)
--    at BEGIN, *before* INSERT/UPDATE on related tables.
-- 2) Triggers remain the enforcement layer for multi-tenant predicates
--    (same user_id / same search scope). They still take advisory locks so that
--    accidental app code without pre-locking serializes when possible, but this
--    is defense-in-depth, not a complete deadlock-free guarantee.
-- 3) On 40P01, retry the entire transaction if the operation is idempotent.
-- 4) 40001 is serialization_failure (stricter isolation), not deadlock.
--
-- PostgreSQL 12+. Additive; does not rewrite 001–006.

CREATE OR REPLACE FUNCTION lock_tenant_subscription(p_subscription_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtext('sub:' || p_subscription_id::text));
$$;

CREATE OR REPLACE FUNCTION lock_tenant_search(p_search_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtext('search:' || p_search_id::text));
$$;

CREATE OR REPLACE FUNCTION lock_tenant_search_result(p_result_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtext('result:' || p_result_id::text));
$$;

COMMENT ON FUNCTION lock_tenant_subscription(UUID) IS
  'Xact advisory lock for subscription-scoped multi-tenant ops; call before mutating payments/subscriptions.';
COMMENT ON FUNCTION lock_tenant_search(UUID) IS
  'Xact advisory lock for search-scoped multi-tenant ops; call before mutating searches/saved_leads/results.';
COMMENT ON FUNCTION lock_tenant_search_result(UUID) IS
  'Xact advisory lock for search_result-scoped ops (is_duplicate_of target).';

COMMENT ON FUNCTION enforce_payment_subscription_same_user() IS
  'Requires payment.user_id = subscription.user_id. Prefer SELECT lock_tenant_subscription(id) before mutating.';
COMMENT ON FUNCTION enforce_subscription_user_change_safe() IS
  'Rejects subscription.user_id change when payments reference it. App should lock_tenant_subscription first.';
COMMENT ON FUNCTION enforce_saved_lead_origin_same_user() IS
  'Requires saved_leads.user_id = searches.user_id for origin_search_id. Prefer lock_tenant_search first.';
COMMENT ON FUNCTION enforce_search_user_change_safe() IS
  'Rejects search.user_id change when leads/results exist. App should lock_tenant_search first.';
COMMENT ON FUNCTION enforce_search_result_duplicate_same_scope() IS
  'is_duplicate_of must stay in same search/user. Prefer lock_tenant_search_result on the target.';
COMMENT ON FUNCTION enforce_search_result_scope_change_safe() IS
  'Blocks moving a result targeted by is_duplicate_of. App should lock_tenant_search_result first.';
