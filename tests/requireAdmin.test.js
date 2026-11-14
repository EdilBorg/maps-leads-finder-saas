const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireAdmin } = require('../src/middleware/auth');

function run(mw, reqBase) {
  return new Promise((resolve) => {
    const req = { ...reqBase };
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    const next = () => resolve({ status: 200, body: { ok: true }, next: true });
    mw(req, res, next);
  });
}

describe('requireAdmin middleware', () => {
  it('401 when not authenticated', async () => {
    const r = await run(requireAdmin, { session: null, user: null });
    assert.equal(r.status, 401);
  });

  it('403 when authenticated non-admin', async () => {
    const r = await run(requireAdmin, {
      session: { userId: 'u1' },
      user: { id: 'u1', role: 'user', emailVerified: true },
    });
    assert.equal(r.status, 403);
  });

  it('403 when admin but email not verified', async () => {
    const r = await run(requireAdmin, {
      session: { userId: 'a1' },
      user: { id: 'a1', role: 'admin', emailVerified: false },
    });
    assert.equal(r.status, 403);
  });

  it('allows admin with verified email', async () => {
    const r = await run(requireAdmin, {
      session: { userId: 'a1' },
      user: { id: 'a1', role: 'admin', emailVerified: true },
    });
    assert.equal(r.next, true);
  });
});
