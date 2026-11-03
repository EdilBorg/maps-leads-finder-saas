/**
 * Rate limiter backed by PostgreSQL (rate_limit_buckets).
 * Shared across process restarts and multiple app instances — no Redis.
 * Falls back to in-process Map only if the database is unavailable
 * (degraded mode; documented in README).
 */

const { getPool } = require('../db/pool');

const memoryBuckets = new Map();

function pruneMemory(now) {
  if (memoryBuckets.size < 2000) return;
  for (const [k, v] of memoryBuckets) {
    if (v.resetAt <= now) memoryBuckets.delete(k);
  }
}

async function hitPg(bucketKey, windowMs, max) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT hit_count, reset_at FROM rate_limit_buckets WHERE bucket_key = $1 FOR UPDATE`,
      [bucketKey]
    );
    const now = new Date();
    let hitCount;
    let resetAt;
    if (!rows.length || new Date(rows[0].reset_at) <= now) {
      hitCount = 1;
      resetAt = new Date(now.getTime() + windowMs);
      await client.query(
        `INSERT INTO rate_limit_buckets (bucket_key, hit_count, reset_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (bucket_key) DO UPDATE SET hit_count = $2, reset_at = $3`,
        [bucketKey, hitCount, resetAt]
      );
    } else {
      hitCount = rows[0].hit_count + 1;
      resetAt = new Date(rows[0].reset_at);
      await client.query(
        `UPDATE rate_limit_buckets SET hit_count = $2 WHERE bucket_key = $1`,
        [bucketKey, hitCount]
      );
    }
    await client.query('COMMIT');
    return { count: hitCount, resetAt, limited: hitCount > max };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
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
        console.warn('[rateLimit] PostgreSQL unavailable, using in-memory fallback:', dbErr.message);
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

module.exports = { rateLimit, resetRateLimits };
