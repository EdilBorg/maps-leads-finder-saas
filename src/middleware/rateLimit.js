/**
 * Lightweight in-memory rate limiter (no external deps).
 */

const buckets = new Map();

function keyFor(parts) {
  return parts.filter(Boolean).join('|');
}

function prune(now) {
  if (buckets.size < 5000) return;
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

function rateLimit({ windowMs, max, keyFn }) {
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    prune(now);
    const id = keyFn ? keyFn(req) : req.ip || 'unknown';
    const k = keyFor([id]);
    let entry = buckets.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(k, entry);
    }
    entry.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: 'Demasiadas tentativas. Tente mais tarde.' });
    }
    return next();
  };
}

function resetRateLimits() {
  buckets.clear();
}

module.exports = { rateLimit, resetRateLimits };
