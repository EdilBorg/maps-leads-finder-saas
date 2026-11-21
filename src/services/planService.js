/**
 * Plan catalogue and per-provider limits.
 */
const PROVIDER_CODES = Object.freeze(['apify', 'brightdata', 'tomtom']);
function getPool() { return require('../db/pool').getPool(); }

async function listPlans({ activeOnly = true } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    activeOnly
      ? `SELECT * FROM plans WHERE is_active = TRUE ORDER BY price_cents ASC, name ASC`
      : `SELECT * FROM plans ORDER BY price_cents ASC, name ASC`
  );
  return rows.map(mapPlan);
}

async function getPlanById(planId, client) {
  const db = client || getPool();
  const { rows } = await db.query(`SELECT * FROM plans WHERE id = $1`, [planId]);
  if (!rows[0]) return null;
  const plan = mapPlan(rows[0]);
  plan.providerLimits = await listProviderLimits(planId, client);
  return plan;
}

async function listProviderLimits(planId, client) {
  const db = client || getPool();
  const { rows } = await db.query(
    `SELECT * FROM plan_provider_limits WHERE plan_id = $1 ORDER BY provider_code`,
    [planId]
  );
  return rows.map(mapLimit);
}

async function upsertProviderLimit(planId, providerCode, limits) {
  if (!PROVIDER_CODES.includes(providerCode)) {
    const err = new Error('Invalid provider_code');
    err.code = 'VALIDATION';
    throw err;
  }
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO plan_provider_limits (
       plan_id, provider_code, max_results_per_period,
       max_cost_micro_usd_per_period, max_api_calls_per_period, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (plan_id, provider_code) DO UPDATE SET
       max_results_per_period = EXCLUDED.max_results_per_period,
       max_cost_micro_usd_per_period = EXCLUDED.max_cost_micro_usd_per_period,
       max_api_calls_per_period = EXCLUDED.max_api_calls_per_period,
       updated_at = NOW()
     RETURNING *`,
    [
      planId, providerCode,
      limits.maxResultsPerPeriod != null ? limits.maxResultsPerPeriod : null,
      limits.maxCostMicroUsdPerPeriod != null ? limits.maxCostMicroUsdPerPeriod : null,
      limits.maxApiCallsPerPeriod != null ? limits.maxApiCallsPerPeriod : null,
    ]
  );
  return mapLimit(rows[0]);
}

async function createPlan(input) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO plans (
       name, description, price_cents, currency,
       max_searches_per_month, max_results_per_month, max_results_per_search,
       features, is_active
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
    [
      input.name, input.description || null,
      input.priceCents != null ? input.priceCents : 0,
      input.currency || 'USD',
      input.maxSearchesPerMonth != null ? input.maxSearchesPerMonth : 0,
      input.maxResultsPerMonth != null ? input.maxResultsPerMonth : 0,
      input.maxResultsPerSearch != null ? input.maxResultsPerSearch : 200,
      JSON.stringify(input.features || {}),
      input.isActive !== false,
    ]
  );
  return mapPlan(rows[0]);
}

async function updatePlan(planId, patch) {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE plans SET
       name = COALESCE($2, name),
       description = COALESCE($3, description),
       price_cents = COALESCE($4, price_cents),
       currency = COALESCE($5, currency),
       max_searches_per_month = COALESCE($6, max_searches_per_month),
       max_results_per_month = COALESCE($7, max_results_per_month),
       max_results_per_search = COALESCE($8, max_results_per_search),
       features = COALESCE($9::jsonb, features),
       is_active = COALESCE($10, is_active),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      planId,
      patch.name != null ? patch.name : null,
      patch.description !== undefined ? patch.description : null,
      patch.priceCents != null ? patch.priceCents : null,
      patch.currency != null ? patch.currency : null,
      patch.maxSearchesPerMonth != null ? patch.maxSearchesPerMonth : null,
      patch.maxResultsPerMonth != null ? patch.maxResultsPerMonth : null,
      patch.maxResultsPerSearch != null ? patch.maxResultsPerSearch : null,
      patch.features != null ? JSON.stringify(patch.features) : null,
      patch.isActive != null ? patch.isActive : null,
    ]
  );
  return rows[0] ? mapPlan(rows[0]) : null;
}

function mapPlan(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, description: row.description,
    priceCents: row.price_cents, currency: row.currency,
    maxSearchesPerMonth: row.max_searches_per_month,
    maxResultsPerMonth: row.max_results_per_month,
    maxResultsPerSearch: row.max_results_per_search,
    features: row.features || {}, isActive: row.is_active,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapLimit(row) {
  if (!row) return null;
  return {
    id: row.id, planId: row.plan_id, providerCode: row.provider_code,
    maxResultsPerPeriod: row.max_results_per_period,
    maxCostMicroUsdPerPeriod: row.max_cost_micro_usd_per_period != null
      ? Number(row.max_cost_micro_usd_per_period) : null,
    maxApiCallsPerPeriod: row.max_api_calls_per_period,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

module.exports = {
  PROVIDER_CODES, listPlans, getPlanById, listProviderLimits,
  upsertProviderLimit, createPlan, updatePlan, mapPlan, mapLimit,
};
