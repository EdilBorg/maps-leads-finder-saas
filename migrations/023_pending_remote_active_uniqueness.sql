-- Active uniqueness for pending_remote_executions (search_id, provider_code)
-- when status ∈ (pending, reconciling, intervention) and search_id IS NOT NULL.
--
-- SAFETY:
-- - Does NOT delete, expire, merge, or free any financial rows.
-- - On active conflicts: RAISE EXCEPTION → migration transaction ROLLBACKs →
--   schema_migrations does NOT record this file as applied (see src/db/migrate.js).
-- - On success: unique partial index is created inside the same transaction.
--
-- Concurrency: SHARE ROW EXCLUSIVE blocks concurrent INSERT/UPDATE/DELETE writers
-- while allowing concurrent readers. Combined with the migration runner transaction,
-- verification + index creation is atomic.

-- Block concurrent writers for the duration of this transaction
LOCK TABLE pending_remote_executions IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  conflict_count INTEGER;
  conflict_detail TEXT;
BEGIN
  SELECT COUNT(*) INTO conflict_count
  FROM (
    SELECT search_id, provider_code
    FROM pending_remote_executions
    WHERE search_id IS NOT NULL
      AND status IN ('pending', 'reconciling', 'intervention')
    GROUP BY search_id, provider_code
    HAVING COUNT(*) > 1
  ) d;

  IF conflict_count > 0 THEN
    SELECT string_agg(line, E'\n') INTO conflict_detail
    FROM (
      SELECT format(
        'search_id=%s provider=%s count=%s ids=%s users=%s external_ids=%s statuses=%s reserved_results=%s reserved_cost=%s reserved_api=%s',
        search_id::text,
        provider_code,
        cnt,
        ids,
        user_ids,
        external_ids,
        statuses,
        reserved_results_list,
        reserved_costs,
        reserved_apis
      ) AS line
      FROM (
        SELECT
          search_id,
          provider_code,
          COUNT(*)::text AS cnt,
          string_agg(id::text, ',' ORDER BY created_at, id) AS ids,
          string_agg(DISTINCT user_id::text, ',') AS user_ids,
          string_agg(COALESCE(external_run_id, '<null>'), ',' ORDER BY created_at, id) AS external_ids,
          string_agg(status, ',' ORDER BY created_at, id) AS statuses,
          string_agg(reserved_results::text, ',' ORDER BY created_at, id) AS reserved_results_list,
          string_agg(reserved_cost_micro_usd::text, ',' ORDER BY created_at, id) AS reserved_costs,
          string_agg(reserved_api_calls::text, ',' ORDER BY created_at, id) AS reserved_apis
        FROM pending_remote_executions
        WHERE search_id IS NOT NULL
          AND status IN ('pending', 'reconciling', 'intervention')
        GROUP BY search_id, provider_code
        HAVING COUNT(*) > 1
        ORDER BY search_id, provider_code
        LIMIT 50
      ) groups
    ) lines;

    RAISE EXCEPTION
      '023_pending_remote_active_uniqueness: % active conflict group(s). Resolve manually, then re-run migrate. Details:%',
      conflict_count,
      E'\n' || COALESCE(conflict_detail, '(no detail)');
  END IF;
END $$;

DROP INDEX IF EXISTS pending_remote_executions_search_provider_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS pending_remote_executions_active_search_provider_uidx
  ON pending_remote_executions (search_id, provider_code)
  WHERE search_id IS NOT NULL
    AND status IN ('pending', 'reconciling', 'intervention');

-- Verify index exists with expected definition
DO $$
DECLARE
  idx_def TEXT;
BEGIN
  SELECT pg_get_indexdef(i.oid) INTO idx_def
  FROM pg_class t
  JOIN pg_index x ON x.indrelid = t.oid
  JOIN pg_class i ON i.oid = x.indexrelid
  WHERE t.relname = 'pending_remote_executions'
    AND i.relname = 'pending_remote_executions_active_search_provider_uidx';

  IF idx_def IS NULL THEN
    RAISE EXCEPTION '023: expected unique index pending_remote_executions_active_search_provider_uidx was not created';
  END IF;

  IF position('UNIQUE' in upper(idx_def)) = 0 THEN
    RAISE EXCEPTION '023: index is not UNIQUE: %', idx_def;
  END IF;

  IF position('pending' in idx_def) = 0
     OR position('reconciling' in idx_def) = 0
     OR position('intervention' in idx_def) = 0 THEN
    RAISE EXCEPTION '023: index predicate missing required statuses: %', idx_def;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pending_remote_executions_intervention_idx
  ON pending_remote_executions (status, updated_at)
  WHERE status = 'intervention';
