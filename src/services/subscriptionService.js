/**
 * Subscription lifecycle and 30-day usage periods (UTC).
 */
const PERIOD_DAYS_DEFAULT = 30;
function getPool() { return require('../db/pool').getPool(); }

async function getPeriodDays() {
  try {
    const { rows } = await getPool().query(
      `SELECT value FROM system_settings WHERE key = 'subscription_period_days'`
    );
    const days = rows[0] && rows[0].value && Number(rows[0].value.days);
    return Number.isFinite(days) && days > 0 ? days : PERIOD_DAYS_DEFAULT;
  } catch (_) { return PERIOD_DAYS_DEFAULT; }
}

async function getActiveSubscription(userId, client) {
  const db = client || getPool();
  const { rows } = await db.query(
    `SELECT s.*, p.name AS plan_name, p.max_results_per_search, p.features
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 AND s.status = 'active'
       AND (s.ends_at IS NULL OR s.ends_at > NOW())
     ORDER BY s.starts_at DESC NULLS LAST, s.created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ? mapSubscription(rows[0]) : null;
}

function resolvePeriodWindow(subscription, now = new Date(), periodDays = PERIOD_DAYS_DEFAULT) {
  if (!subscription || !subscription.startsAt) return null;
  const startMs = new Date(subscription.startsAt).getTime();
  const nowMs = now.getTime();
  if (nowMs < startMs) return null;
  if (subscription.endsAt && nowMs >= new Date(subscription.endsAt).getTime()) return null;
  const dayMs = periodDays * 24 * 60 * 60 * 1000;
  const index = Math.floor((nowMs - startMs) / dayMs);
  const periodStart = new Date(startMs + index * dayMs);
  let periodEnd = new Date(startMs + (index + 1) * dayMs);
  if (subscription.endsAt) {
    const ends = new Date(subscription.endsAt);
    if (periodEnd > ends) periodEnd = ends;
  }
  if (periodEnd <= periodStart) return null;
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    periodIndex: index,
    periodDays,
  };
}

async function activateSubscription({ userId, planId, source = 'manual', externalRef = null, client }) {
  const db = client || getPool();
  const periodDays = await getPeriodDays();
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + periodDays * 24 * 60 * 60 * 1000);
  await db.query(
    `UPDATE subscriptions SET status = 'expired', updated_at = NOW()
     WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  const { rows } = await db.query(
    `INSERT INTO subscriptions (user_id, plan_id, status, starts_at, ends_at, source, external_ref)
     VALUES ($1,$2,'active',$3,$4,$5,$6) RETURNING *`,
    [userId, planId, startsAt.toISOString(), endsAt.toISOString(), source, externalRef]
  );
  return mapSubscription(rows[0]);
}

async function cancelSubscription(subscriptionId, userId, { client } = {}) {
  const db = client || getPool();
  const { rows } = await db.query(
    `UPDATE subscriptions SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'active' RETURNING *`,
    [subscriptionId, userId]
  );
  return rows[0] ? mapSubscription(rows[0]) : null;
}

async function listSubscriptionsForUser(userId) {
  const { rows } = await getPool().query(
    `SELECT s.*, p.name AS plan_name FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
    [userId]
  );
  return rows.map(mapSubscription);
}

function mapSubscription(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, planId: row.plan_id,
    planName: row.plan_name || null, status: row.status,
    startsAt: row.starts_at, endsAt: row.ends_at, source: row.source,
    externalRef: row.external_ref,
    maxResultsPerSearch: row.max_results_per_search != null ? row.max_results_per_search : null,
    features: row.features || null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

module.exports = {
  PERIOD_DAYS_DEFAULT, getPeriodDays, getActiveSubscription, resolvePeriodWindow,
  activateSubscription, cancelSubscription, listSubscriptionsForUser, mapSubscription,
};
