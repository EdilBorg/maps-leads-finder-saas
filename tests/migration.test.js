const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('migration SQL shape', () => {
  it('001_auth.sql has no OIDS clause and defines session PK', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_auth.sql'), 'utf8');
    assert.equal(/OIDS/i.test(sql), false);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "session"/);
    assert.match(sql, /PRIMARY KEY/);
    assert.match(sql, /rate_limit_buckets/);
  });

  it('002_fix_session_oids.sql is idempotent DDL', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'migrations', '002_fix_session_oids.sql'),
      'utf8'
    );
    assert.equal(/OIDS/i.test(sql), false);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS "session"/);
  });
});
