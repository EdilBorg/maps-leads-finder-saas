/**
 * Selective cleanup of auth rate-limit / login-attempt state for integration tests.
 * Only runs against a database authorized by testDbGuard.
 */
const { assertSafeTestDatabase } = require('./testDbGuard');

/** IPs typically seen when tests hit the app over loopback. */
const TEST_LOOPBACK_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

function rateKeysForIp(ip) {
  return [`login:${ip}`, `reg:${ip}`, `forgot:${ip}`, `resend:${ip}`];
}

/**
 * Clear in-memory + PostgreSQL rate-limit buckets for loopback test IPs,
 * and login_attempts rows scoped to the suite when possible.
 *
 * When `emails` is provided, only those emails are deleted from login_attempts
 * (avoids wiping unrelated attempts for the same loopback IPs).
 * When only IPs are given (or neither), falls back to IP-based cleanup.
 *
 * Rate-limit buckets remain IP-scoped because the middleware keys on IP.
 *
 * @param {{ emails?: string[], ips?: string[] }} [opts]
 */
async function clearAuthTestState(opts = {}) {
  assertSafeTestDatabase();
  const ips = opts.ips && opts.ips.length ? opts.ips : TEST_LOOPBACK_IPS;
  const emails = (opts.emails || []).map((e) => String(e).toLowerCase());

  const { resetRateLimits, clearPgBucket } = require('../../src/middleware/rateLimit');
  resetRateLimits();

  for (const ip of ips) {
    for (const key of rateKeysForIp(ip)) {
      try {
        await clearPgBucket(key);
      } catch (_) {
        /* table may not exist in pure unit runs */
      }
    }
  }

  try {
    const { getPool } = require('../../src/db/pool');
    const pool = getPool();
    if (emails.length) {
      // Prefer email-scoped delete so concurrent/other suites' IP-shared attempts are not wiped.
      await pool.query(
        `DELETE FROM login_attempts WHERE email_normalized = ANY($1::text[])`,
        [emails]
      );
    } else if (ips.length) {
      await pool.query(`DELETE FROM login_attempts WHERE ip = ANY($1::text[])`, [ips]);
    }
  } catch (_) {
    /* ignore when DB unavailable in unit-only runs */
  }
}

module.exports = {
  clearAuthTestState,
  TEST_LOOPBACK_IPS,
  rateKeysForIp,
};
