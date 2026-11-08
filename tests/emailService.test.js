/**
 * Unit tests for Brevo HTTP email service.
 * Mocks global fetch — never contacts the real API.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_INFO = console.info;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_ERROR = console.error;

function loadService() {
  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/services/emailService')];
  return require('../src/services/emailService');
}

function mockFetch(impl) {
  global.fetch = mock.fn(impl);
  return global.fetch;
}

/** Capture console.info/warn/error into a flat string for leak checks. */
function captureConsole() {
  const lines = [];
  const push = (...args) => {
    lines.push(
      args
        .map((a) => {
          if (typeof a === 'string') return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ')
    );
  };
  console.info = (...args) => push(...args);
  console.warn = (...args) => push(...args);
  console.error = (...args) => push(...args);
  return {
    lines,
    joined() {
      return lines.join('\n');
    },
    restore() {
      console.info = ORIGINAL_INFO;
      console.warn = ORIGINAL_WARN;
      console.error = ORIGINAL_ERROR;
    },
  };
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
  console.info = ORIGINAL_INFO;
  console.warn = ORIGINAL_WARN;
  console.error = ORIGINAL_ERROR;
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

// ---------------------------------------------------------------------------
// Security: logs and errors must never expose recipients, tokens, or links
// ---------------------------------------------------------------------------

describe('security — development logs omit recipient and token links', () => {
  it('sendVerificationEmail without API key does not log email, token, or link', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.BREVO_API_KEY;

    const token = 'VERIFY_SECRET_TOKEN_9f3a2b1c';
    const email = 'secret.user@example.com';
    const verifyUrl = `https://maps-leads-finder-saas.onrender.com/pages/verify-email.html?token=${token}`;

    const cap = captureConsole();
    try {
      const { sendVerificationEmail } = loadService();
      const result = await sendVerificationEmail(email, verifyUrl);
      assert.equal(result.sent, false);
      assert.equal(result.mode, 'log');

      const joined = cap.joined();
      assert.doesNotMatch(joined, new RegExp(email.replace(/\./g, '\\.')));
      assert.doesNotMatch(joined, new RegExp(token));
      assert.doesNotMatch(joined, /verify-email\.html/);
      assert.doesNotMatch(joined, /textPreview/);
      assert.doesNotMatch(joined, /Confirme o seu email abrindo/);
    } finally {
      cap.restore();
    }
  });

  it('sendPasswordResetEmail without API key does not log token or reset link', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.BREVO_API_KEY;

    const token = 'RESET_SECRET_TOKEN_7d4e8c2a';
    const email = 'reset.target@example.com';
    const resetUrl = `https://maps-leads-finder-saas.onrender.com/pages/reset-password.html?token=${token}`;

    const cap = captureConsole();
    try {
      const { sendPasswordResetEmail } = loadService();
      const result = await sendPasswordResetEmail(email, resetUrl);
      assert.equal(result.sent, false);

      const joined = cap.joined();
      assert.doesNotMatch(joined, new RegExp(email.replace(/\./g, '\\.')));
      assert.doesNotMatch(joined, new RegExp(token));
      assert.doesNotMatch(joined, /reset-password\.html/);
      assert.doesNotMatch(joined, /textPreview/);
    } finally {
      cap.restore();
    }
  });
});

describe('security — Brevo error body with sensitive payload is not leaked', () => {
  it('non-2xx response containing email/token/link does not surface them', async () => {
    const secretKey = 'BREVO_TEST_SECRET_123456';
    process.env.BREVO_API_KEY = secretKey;
    process.env.MAIL_FROM = 'noreply@example.com';

    const poisonEmail = 'poisoned@example.com';
    const poisonToken = 'POISON_TOKEN_aabbccdd';
    const poisonLink = `https://evil.example/pages/verify-email.html?token=${poisonToken}`;

    mockFetch(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        code: 'invalid_parameter',
        message: `Invalid to: ${poisonEmail} link=${poisonLink} token=${poisonToken}`,
      }),
    }));

    const cap = captureConsole();
    let caught;
    try {
      const { sendMail } = loadService();
      try {
        await sendMail({
          to: poisonEmail,
          subject: 'S',
          text: `click ${poisonLink}`,
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      const errText = `${caught.message}\n${caught.stack || ''}`;
      assert.doesNotMatch(errText, new RegExp(poisonEmail.replace(/\./g, '\\.')));
      assert.doesNotMatch(errText, new RegExp(poisonToken));
      assert.doesNotMatch(errText, /verify-email\.html/);
      assert.doesNotMatch(errText, new RegExp(secretKey));

      const joined = cap.joined();
      assert.doesNotMatch(joined, new RegExp(poisonEmail.replace(/\./g, '\\.')));
      assert.doesNotMatch(joined, new RegExp(poisonToken));
      assert.doesNotMatch(joined, /verify-email\.html/);
      assert.doesNotMatch(joined, new RegExp(secretKey));
      // Safe technical fields may still be present
      assert.match(joined, /status/);
    } finally {
      cap.restore();
    }
  });
});

describe('security — API key never appears in logs or errors', () => {
  it('HTTP error path excludes BREVO_TEST_SECRET_123456', async () => {
    const secretKey = 'BREVO_TEST_SECRET_123456';
    process.env.BREVO_API_KEY = secretKey;
    process.env.MAIL_FROM = 'noreply@example.com';

    mockFetch(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ code: 'forbidden', message: 'nope' }),
    }));

    const cap = captureConsole();
    try {
      const { sendMail } = loadService();
      let caught;
      try {
        await sendMail({ to: 'a@b.co', subject: 'S', text: 't' });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.doesNotMatch(String(caught.message), new RegExp(secretKey));
      assert.doesNotMatch(cap.joined(), new RegExp(secretKey));
    } finally {
      cap.restore();
    }
  });

  it('network error path excludes BREVO_TEST_SECRET_123456', async () => {
    const secretKey = 'BREVO_TEST_SECRET_123456';
    process.env.BREVO_API_KEY = secretKey;
    process.env.MAIL_FROM = 'noreply@example.com';

    mockFetch(async () => {
      throw new Error('connect ECONNREFUSED 1.2.3.4');
    });

    const cap = captureConsole();
    try {
      const { sendMail } = loadService();
      let caught;
      try {
        await sendMail({ to: 'a@b.co', subject: 'S', text: 't' });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.doesNotMatch(String(caught.message), new RegExp(secretKey));
      assert.doesNotMatch(String(caught.stack || ''), new RegExp(secretKey));
      assert.doesNotMatch(cap.joined(), new RegExp(secretKey));
    } finally {
      cap.restore();
    }
  });
});

describe('security — production requires MAIL_FROM', () => {
  it('rejects when MAIL_FROM is missing and does not call fetch', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'production-secret-min-16chars';
    process.env.DATABASE_URL = 'postgresql://x/y_test';
    process.env.BREVO_API_KEY = 'BREVO_TEST_SECRET_123456';
    delete process.env.MAIL_FROM;

    const fetchMock = mockFetch(async () => {
      throw new Error('fetch should not be called');
    });

    const cap = captureConsole();
    try {
      const { sendMail } = loadService();
      let caught;
      try {
        await sendMail({ to: 'user@example.com', subject: 'Hi', text: 'x' });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.match(String(caught.message), /MAIL_FROM/i);
      assert.equal(fetchMock.mock.callCount(), 0);
      assert.doesNotMatch(String(caught.message), /BREVO_TEST_SECRET/);
      assert.doesNotMatch(cap.joined(), /BREVO_TEST_SECRET/);
      assert.doesNotMatch(cap.joined(), /user@example\.com/);
    } finally {
      cap.restore();
    }
  });

  it('rejects invalid MAIL_FROM in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'production-secret-min-16chars';
    process.env.DATABASE_URL = 'postgresql://x/y_test';
    process.env.BREVO_API_KEY = 'BREVO_TEST_SECRET_123456';
    process.env.MAIL_FROM = 'not-an-email';

    const fetchMock = mockFetch(async () => {
      throw new Error('fetch should not be called');
    });

    const { sendMail } = loadService();
    await assert.rejects(
      () => sendMail({ to: 'user@example.com', subject: 'Hi', text: 'x' }),
      /MAIL_FROM/i
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// Refinement: subject omitted from logs; network errors use fixed categories
// ---------------------------------------------------------------------------

describe('security refinement — subject never logged in development', () => {
  it('sendMail with sensitive subject does not log subject, recipient, or body', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.BREVO_API_KEY;

    const secretSubject = 'PRIVATE_USER_DATA_987654';
    const email = 'subject.leak@example.com';
    const bodyText = 'BODY_MUST_NOT_APPEAR_XYZ';

    const fetchMock = mockFetch(async () => {
      throw new Error('fetch should not be called');
    });
    const cap = captureConsole();
    try {
      const { sendMail } = loadService();
      const result = await sendMail({
        to: email,
        subject: secretSubject,
        text: bodyText,
      });
      assert.equal(result.sent, false);
      assert.equal(result.mode, 'log');
      assert.equal(fetchMock.mock.callCount(), 0);

      const joined = cap.joined();
      assert.doesNotMatch(joined, new RegExp(secretSubject));
      assert.doesNotMatch(joined, new RegExp(email.replace(/\./g, '\\.')));
      assert.doesNotMatch(joined, new RegExp(bodyText));
      assert.match(joined, /mode/);
    } finally {
      cap.restore();
    }
  });

  it('sendPasswordResetEmail without key does not log template subject or link', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.BREVO_API_KEY;

    const token = 'RESET_REFINE_TOKEN_55aa';
    const email = 'reset.refine@example.com';
    const resetUrl = `https://app.example/pages/reset-password.html?token=${token}`;

    const cap = captureConsole();
    try {
      const { sendPasswordResetEmail } = loadService();
      const result = await sendPasswordResetEmail(email, resetUrl);
      assert.equal(result.sent, false);
      assert.equal(result.mode, 'log');

      const joined = cap.joined();
      assert.doesNotMatch(joined, /Redefinição de palavra-passe/);
      assert.doesNotMatch(joined, /Maps Leads Finder/);
      assert.doesNotMatch(joined, new RegExp(email.replace(/\./g, '\\.')));
      assert.doesNotMatch(joined, new RegExp(token));
      assert.doesNotMatch(joined, /reset-password\.html/);
    } finally {
      cap.restore();
    }
  });
});

describe('security refinement — network errors use fixed categories only', () => {
  it('arbitrary err.name and message are not logged or propagated', async () => {
    process.env.BREVO_API_KEY = 'BREVO_TEST_SECRET_123456';
    process.env.MAIL_FROM = 'noreply@example.com';

    mockFetch(async () => {
      const err = new Error('SENSITIVE_ERROR_MESSAGE_123');
      err.name = 'PRIVATE_DATA_SHOULD_NOT_BE_LOGGED';
      throw err;
    });

    const cap = captureConsole();
    let caught;
    try {
      const { sendMail } = loadService();
      try {
        await sendMail({ to: 'victim@example.com', subject: 'S', text: 't' });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.match(String(caught.message), /Email provider request failed/);
      assert.doesNotMatch(String(caught.message), /SENSITIVE_ERROR_MESSAGE_123/);
      assert.doesNotMatch(String(caught.message), /PRIVATE_DATA_SHOULD_NOT_BE_LOGGED/);

      const joined = cap.joined();
      assert.match(joined, /\[email\] Brevo request failed/);
      assert.doesNotMatch(joined, /SENSITIVE_ERROR_MESSAGE_123/);
      assert.doesNotMatch(joined, /PRIVATE_DATA_SHOULD_NOT_BE_LOGGED/);
      assert.doesNotMatch(joined, /BREVO_TEST_SECRET_123456/);
      assert.doesNotMatch(joined, /victim@example\.com/);
    } finally {
      cap.restore();
    }
  });

  it('TimeoutError logs fixed timeout category only', async () => {
    process.env.BREVO_API_KEY = 'BREVO_TEST_SECRET_123456';
    process.env.MAIL_FROM = 'noreply@example.com';

    mockFetch(async () => {
      const err = new Error('Sensitive timeout details');
      err.name = 'TimeoutError';
      throw err;
    });

    const cap = captureConsole();
    try {
      const { sendMail } = loadService();
      await assert.rejects(
        () => sendMail({ to: 'a@b.co', subject: 'S', text: 't' }),
        /Email provider timeout/
      );
      const joined = cap.joined();
      assert.match(joined, /\[email\] Brevo request timed out/);
      assert.doesNotMatch(joined, /Sensitive timeout details/);
      assert.doesNotMatch(joined, /TimeoutError/);
    } finally {
      cap.restore();
    }
  });

  it('AbortError is classified as timeout with fixed log only', async () => {
    process.env.BREVO_API_KEY = 'BREVO_TEST_SECRET_123456';
    process.env.MAIL_FROM = 'noreply@example.com';

    mockFetch(async () => {
      const err = new Error('Aborted with secrets');
      err.name = 'AbortError';
      throw err;
    });

    const cap = captureConsole();
    try {
      const { sendMail } = loadService();
      await assert.rejects(
        () => sendMail({ to: 'a@b.co', subject: 'S', text: 't' }),
        /Email provider timeout/
      );
      const joined = cap.joined();
      assert.match(joined, /\[email\] Brevo request timed out/);
      assert.doesNotMatch(joined, /Aborted with secrets/);
      assert.doesNotMatch(joined, /AbortError/);
    } finally {
      cap.restore();
    }
  });

  it('generic network failure logs only fixed failed category', async () => {
    process.env.BREVO_API_KEY = 'BREVO_TEST_SECRET_123456';
    process.env.MAIL_FROM = 'noreply@example.com';

    mockFetch(async () => {
      const err = new Error('ECONNREFUSED secrets-here');
      err.name = 'UnexpectedNetworkName';
      throw err;
    });

    const cap = captureConsole();
    try {
      const { sendMail } = loadService();
      await assert.rejects(
        () => sendMail({ to: 'a@b.co', subject: 'S', text: 't' }),
        /Email provider request failed/
      );
      const joined = cap.joined();
      assert.match(joined, /\[email\] Brevo request failed/);
      assert.doesNotMatch(joined, /ECONNREFUSED/);
      assert.doesNotMatch(joined, /UnexpectedNetworkName/);
      assert.doesNotMatch(joined, /secrets-here/);
    } finally {
      cap.restore();
    }
  });
});
