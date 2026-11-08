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
 * and optionally login_attempts rows for those IPs / emails.
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
    if (ips.length) {
      await pool.query(`DELETE FROM login_attempts WHERE ip = ANY($1::text[])`, [ips]);
    }
    if (emails.length) {
      await pool.query(
        `DELETE FROM login_attempts WHERE email_normalized = ANY($1::text[])`,
        [emails]
      );
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
