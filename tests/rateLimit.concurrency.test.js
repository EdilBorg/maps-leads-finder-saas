/**
 * Concurrent rate-limit hits against PostgreSQL.
 * Skipped when DATABASE_URL is not set.
 */
require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const hasDb = Boolean(process.env.DATABASE_URL || process.env.PGHOST);

describe('rate limit atomic concurrency', { skip: !hasDb }, () => {
  let hitPg;
  let clearPgBucket;
  let getPool;
  let closePool;
  const bucket = `concurrent-test-${Date.now()}`;

  before(async () => {
    ({ hitPg, clearPgBucket } = require('../src/middleware/rateLimit'));
    ({ getPool, closePool } = require('../src/db/pool'));
    const fs = require('fs');
    const path = require('path');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_auth.sql'), 'utf8');
    await getPool().query(sql);
    await clearPgBucket(bucket);
  });

  after(async () => {
    try {
      await clearPgBucket(bucket);
    } catch (_) {}
    try {
      await closePool();
    } catch (_) {}
  });

  it('50 concurrent hits produce exactly 50 increments', async () => {
    await clearPgBucket(bucket);
    const windowMs = 60_000;
    const max = 1000;
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => hitPg(bucket, windowMs, max))
    );
    const counts = results.map((r) => r.count).sort((a, b) => a - b);
    assert.equal(counts[0], 1);
    assert.equal(counts[counts.length - 1], N);
    assert.equal(new Set(counts).size, N);

    const { rows } = await getPool().query(
      `SELECT hit_count FROM rate_limit_buckets WHERE bucket_key = $1`,
      [bucket]
    );
    assert.equal(rows[0].hit_count, N);
  });

  it('marks limited once count exceeds max under concurrency', async () => {
    const key = `${bucket}-cap`;
    await clearPgBucket(key);
    const windowMs = 60_000;
    const max = 5;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => hitPg(key, windowMs, max))
    );
    const limited = results.filter((r) => r.limited).length;
    const notLimited = results.filter((r) => !r.limited).length;
    assert.equal(notLimited, 5);
    assert.equal(limited, 7);
    await clearPgBucket(key);
  });
});
