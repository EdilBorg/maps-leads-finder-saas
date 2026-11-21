/**
 * Subscription lifecycle and 30-day usage periods (UTC).
 */
const PERIOD_DAYS_DEFAULT = 30;
function getPool() { return require('../db/pool').getPool(); }

async function getPeriodDays(client) {
  const db = client || getPool();
  try {
    const { rows } = await db.query(
      `SELECT value FROM system_settings WHERE key = 'subscription_period_days'`
    );
    const days = rows[0] && rows[0].value && Number(rows[0].value.days);
    return Number.isFinite(days) && days > 0 ? days : PERIOD_DAYS_DEFAULT;
  } catch (err) {
    if (err && (err.code === '42P01' || err.code === '42703')) return PERIOD_DAYS_DEFAULT;
    if (process.env.STRICT_DB_ERRORS === '1') throw err;
    return PERIOD_DAYS_DEFAULT;
  }
}

async function getActiveSubscription(userId, client) {
  const db = client || getPool();
  const { rows } = await db.query(
    `SELECT s.*, p.name AS plan_name, p.max_results_per_search, p.max_results_per_month, p.price_cents, p.currency, p.features
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 AND s.status = 'active'
       AND (s.ends_at IS NULL OR s.ends_at > NOW())
     ORDER BY s.starts_at DESC NULLS LAST, s.created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ? mapSubscription(rows[0]) : null;
}

function resolvePeriodWindow(subscription, now = new Date(), periodDaysOverride = null) {
  if (!subscription || !subscription.startsAt) return null;
  let periodDays = PERIOD_DAYS_DEFAULT;
  if (subscription.periodDays != null && Number.isFinite(Number(subscription.periodDays)) && Number(subscription.periodDays) > 0) {
    periodDays = Number(subscription.periodDays);
  } else if (periodDaysOverride != null && Number.isFinite(Number(periodDaysOverride)) && Number(periodDaysOverride) > 0) {
    periodDays = Number(periodDaysOverride);
  }
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

async function activateSubscription({ userId, planId, source = 'gateway', externalRef = null, client }) {
  const own = !client;
  const db = client || (await getPool().connect());
  try {
    if (own) await db.query('BEGIN');
    await db.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const periodDays = PERIOD_DAYS_DEFAULT;
    const now = new Date();

    // Lock any currently active row for this user (serialise concurrent activations).
    const { rows: activeRows } = await db.query(
      `SELECT * FROM subscriptions
       WHERE user_id = $1 AND status = 'active'
       ORDER BY ends_at DESC NULLS LAST, created_at DESC
       FOR UPDATE`,
      [userId]
    );
    const active = activeRows[0] || null;
    const activeStillValid =
      active &&
      String(active.plan_id) === String(planId) &&
      active.ends_at &&
      new Date(active.ends_at).getTime() > now.getTime();

    if (activeStillValid) {
      // Renewal: keep starts_at, extend ends_at by one full period from current ends_at.
      const baseEnd = new Date(active.ends_at);
      const newEnds = new Date(baseEnd.getTime() + periodDays * 24 * 60 * 60 * 1000);
      await db.query(
        `UPDATE subscriptions SET status = 'expired', updated_at = NOW()
         WHERE user_id = $1 AND status = 'active' AND id <> $2`,
        [userId, active.id]
      );
      const { rows } = await db.query(
        `UPDATE subscriptions SET
           ends_at = $2,
           source = COALESCE($3, source),
           external_ref = COALESCE($4, external_ref),
           period_days = $5,
           updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [active.id, newEnds.toISOString(), source, externalRef, periodDays]
      );
      if (own) await db.query('COMMIT');
      return mapSubscription(rows[0]);
    }

    // New cycle: expire previous active rows, start 30 days from now.
    const startsAt = now;
    const endsAt = new Date(startsAt.getTime() + periodDays * 24 * 60 * 60 * 1000);
    await db.query(
      `UPDATE subscriptions SET status = 'expired', updated_at = NOW()
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    const { rows } = await db.query(
      `INSERT INTO subscriptions (
         user_id, plan_id, status, starts_at, ends_at, source, external_ref, period_days
       ) VALUES ($1,$2,'active',$3,$4,$5,$6,$7) RETURNING *`,
      [userId, planId, startsAt.toISOString(), endsAt.toISOString(), source, externalRef, periodDays]
    );
    if (own) await db.query('COMMIT');
    return mapSubscription(rows[0]);
  } catch (err) {
    if (own) { try { await db.query('ROLLBACK'); } catch (_) {} }
    throw err;
  } finally {
    if (own && typeof db.release === 'function') db.release();
  }
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
    periodDays: row.period_days != null ? Number(row.period_days) : PERIOD_DAYS_DEFAULT,
    maxResultsPerSearch: row.max_results_per_search != null ? row.max_results_per_search : null,
    maxResultsPerMonth: row.max_results_per_month != null ? Number(row.max_results_per_month) : null,
    priceCents: row.price_cents != null ? Number(row.price_cents) : null,
    currency: row.currency || null,
    features: row.features || null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

module.exports = {
  PERIOD_DAYS_DEFAULT, getPeriodDays, getActiveSubscription, resolvePeriodWindow,
  activateSubscription, cancelSubscription, listSubscriptionsForUser, mapSubscription,
};
