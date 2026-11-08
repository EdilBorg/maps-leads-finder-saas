/**
 * Unit tests for Brevo HTTP email service.
 * Mocks global fetch — never contacts the real API.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function loadService() {
  // Fresh require so env/config changes take effect.
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/services/emailService')];
  return require('../src/services/emailService');
}

function mockFetch(impl) {
  global.fetch = mock.fn(impl);
  return global.fetch;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.BREVO_API_KEY;
  delete process.env.MAIL_FROM;
  delete process.env.MAIL_FROM_NAME;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
  mock.restoreAll();
});

describe('emailService sendMail — development without key', () => {
  it('logs and returns sent:false mode:log without calling fetch', async () => {
    process.env.NODE_ENV = 'development';
    const fetchMock = mockFetch(async () => {
      throw new Error('fetch should not be called');
    });
    const { sendMail } = loadService();
    const result = await sendMail({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'body',
    });
    assert.equal(result.sent, false);
    assert.equal(result.mode, 'log');
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

describe('emailService sendMail — production without key', () => {
  it('throws and does not report success', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'production-secret-min-16chars';
    process.env.DATABASE_URL = 'postgresql://x/y_test';
    const fetchMock = mockFetch(async () => {
      throw new Error('fetch should not be called');
    });
    const { sendMail } = loadService();
    await assert.rejects(
      () => sendMail({ to: 'user@example.com', subject: 'Hi', text: 'x' }),
      /not configured/i
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

describe('emailService sendMail — successful Brevo call', () => {
  it('POSTs correct URL, headers, and body; returns sent:true', async () => {
    process.env.NODE_ENV = 'development';
    process.env.BREVO_API_KEY = 'test-api-key-value';
    process.env.MAIL_FROM = 'noreply@example.com';
    process.env.MAIL_FROM_NAME = 'Maps Leads Finder';

    const fetchMock = mockFetch(async (url, options) => {
      assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['api-key'], 'test-api-key-value');
      assert.equal(options.headers['content-type'], 'application/json');
      assert.ok(options.signal, 'timeout signal expected');

      const body = JSON.parse(options.body);
      assert.equal(body.sender.email, 'noreply@example.com');
      assert.equal(body.sender.name, 'Maps Leads Finder');
      assert.deepEqual(body.to, [{ email: 'dest@example.com' }]);
      assert.equal(body.subject, 'Test subject');
      assert.equal(body.textContent, 'plain text');
      assert.equal(body.htmlContent, '<p>html</p>');

      return {
        ok: true,
        status: 201,
        json: async () => ({ messageId: 'msg-abc-123' }),
      };
    });

    const { sendMail } = loadService();
    const result = await sendMail({
      to: 'dest@example.com',
      subject: 'Test subject',
      text: 'plain text',
      html: '<p>html</p>',
    });

    assert.equal(result.sent, true);
    assert.equal(result.mode, 'brevo-api');
    assert.equal(result.messageId, 'msg-abc-123');
    assert.equal(fetchMock.mock.callCount(), 1);
  });
});

describe('emailService sendMail — non-2xx response', () => {
  it('throws without exposing the API key', async () => {
    process.env.BREVO_API_KEY = 'super-secret-key-do-not-leak';
    process.env.MAIL_FROM = 'noreply@example.com';

    mockFetch(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: 'unauthorized', message: 'Key not found' }),
    }));

    const { sendMail } = loadService();
    let caught;
    try {
      await sendMail({ to: 'a@b.co', subject: 'S', text: 't' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.match(String(caught.message), /rejected|provider/i);
    assert.doesNotMatch(String(caught.message), /super-secret-key/);
    assert.doesNotMatch(String(caught.stack || ''), /super-secret-key/);
  });
});

describe('emailService sendMail — timeout', () => {
  it('maps AbortError/TimeoutError to a clean provider timeout error', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.MAIL_FROM = 'noreply@example.com';

    mockFetch(async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });

    const { sendMail } = loadService();
    await assert.rejects(
      () => sendMail({ to: 'a@b.co', subject: 'S', text: 't' }),
      /timeout/i
    );
  });
});

describe('emailService sendMail — validation', () => {
  it('requires to and subject', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.MAIL_FROM = 'noreply@example.com';
    const { sendMail } = loadService();
    await assert.rejects(() => sendMail({ to: '', subject: 'S' }), /requires/);
    await assert.rejects(() => sendMail({ to: 'a@b.co', subject: '' }), /requires/);
  });
});

describe('emailService templates', () => {
  it('sendVerificationEmail builds subject and includes verify URL', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.MAIL_FROM = 'noreply@example.com';

    let captured;
    mockFetch(async (_url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'v1' }) };
    });

    const { sendVerificationEmail } = loadService();
    const url = 'https://app.example/pages/verify-email.html?token=abc';
    const result = await sendVerificationEmail('user@example.com', url);

    assert.equal(result.sent, true);
    assert.match(captured.subject, /Confirme/i);
    assert.ok(captured.textContent.includes(url));
    assert.ok(captured.htmlContent.includes(url));
    assert.equal(captured.to[0].email, 'user@example.com');
  });

  it('sendPasswordResetEmail builds subject and includes reset URL', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.MAIL_FROM = 'noreply@example.com';

    let captured;
    mockFetch(async (_url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'r1' }) };
    });

    const { sendPasswordResetEmail } = loadService();
    const url = 'https://app.example/pages/reset-password.html?token=xyz';
    const result = await sendPasswordResetEmail('user@example.com', url);

    assert.equal(result.sent, true);
    assert.match(captured.subject, /palavra-passe|password/i);
    assert.ok(captured.textContent.includes(url));
    assert.ok(captured.htmlContent.includes(url));
  });
});

describe('emailService does not leak API key in errors', () => {
  it('network failure message excludes the key', async () => {
    process.env.BREVO_API_KEY = 'leaked-key-should-not-appear';
    process.env.MAIL_FROM = 'noreply@example.com';

    mockFetch(async () => {
      throw new Error('connect ECONNREFUSED');
    });

    const { sendMail } = loadService();
    let caught;
    try {
      await sendMail({ to: 'a@b.co', subject: 'S', text: 't' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.doesNotMatch(String(caught.message), /leaked-key/);
    assert.doesNotMatch(String(caught.stack || ''), /leaked-key/);
  });
});
