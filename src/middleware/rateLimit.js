/**
 * Rate limiter backed by PostgreSQL (rate_limit_buckets).
 * Shared across process restarts and multiple app instances — no Redis.
 *
 * Atomic increment uses a single INSERT ... ON CONFLICT DO UPDATE so concurrent
 * requests on the same bucket cannot under-count.
 *
 * Falls back to in-process Map only if the database is unavailable
 * (degraded mode: NOT distributed; documented in README).
 */

const { getPool } = require('../db/pool');

const memoryBuckets = new Map();
let lastCleanupAt = 0;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function pruneMemory(now) {
  if (memoryBuckets.size < 2000) return;
  for (const [k, v] of memoryBuckets) {
    if (v.resetAt <= now) memoryBuckets.delete(k);
  }
}

/**
 * Atomically record a hit and return { count, resetAt, limited }.
 * Exported for concurrency tests.
 */
async function hitPg(bucketKey, windowMs, max) {
  const pool = getPool();
  const resetAtCandidate = new Date(Date.now() + windowMs);

  const { rows } = await pool.query(
    `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at)
     VALUES ($1, 1, $2)
     ON CONFLICT (bucket_key) DO UPDATE SET
       hit_count = CASE
         WHEN rate_limit_buckets.reset_at <= NOW() THEN 1
         ELSE rate_limit_buckets.hit_count + 1
       END,
       reset_at = CASE
         WHEN rate_limit_buckets.reset_at <= NOW() THEN EXCLUDED.reset_at
         ELSE rate_limit_buckets.reset_at
       END
     RETURNING hit_count, reset_at`,
    [bucketKey, resetAtCandidate]
  );

  const hitCount = rows[0].hit_count;
  const resetAt = new Date(rows[0].reset_at);

  const now = Date.now();
  if (now - lastCleanupAt > CLEANUP_INTERVAL_MS) {
    lastCleanupAt = now;
    pool
      .query(`DELETE FROM rate_limit_buckets WHERE reset_at < NOW() - interval '1 hour'`)
      .catch((err) => console.warn('[rateLimit] cleanup failed:', err.message));
  }

  return { count: hitCount, resetAt, limited: hitCount > max };
}

function hitMemory(bucketKey, windowMs, max) {
  const now = Date.now();
  pruneMemory(now);
  let entry = memoryBuckets.get(bucketKey);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    memoryBuckets.set(bucketKey, entry);
  }
  entry.count += 1;
  return {
    count: entry.count,
    resetAt: new Date(entry.resetAt),
    limited: entry.count > max,
  };
}

function rateLimit({ windowMs, max, keyFn }) {
  return async function rateLimitMiddleware(req, res, next) {
    try {
      const id = keyFn ? keyFn(req) : req.ip || 'unknown';
      const bucketKey = String(id);

      let result;
      try {
        result = await hitPg(bucketKey, windowMs, max);
      } catch (dbErr) {
        console.warn(
          '[rateLimit] PostgreSQL unavailable, using in-memory fallback (not distributed):',
          dbErr.message
        );
        result = hitMemory(bucketKey, windowMs, max);
      }

      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - result.count)));

      if (result.limited) {
        const retry = Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
        res.setHeader('Retry-After', String(retry));
        return res.status(429).json({ error: 'Demasiadas tentativas. Tente mais tarde.' });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

function resetRateLimits() {
  memoryBuckets.clear();
}

async function clearPgBucket(bucketKey) {
  await getPool().query(`DELETE FROM rate_limit_buckets WHERE bucket_key = $1`, [bucketKey]);
}

module.exports = {
  rateLimit,
  resetRateLimits,
  hitPg,
  hitMemory,
  clearPgBucket,
};
