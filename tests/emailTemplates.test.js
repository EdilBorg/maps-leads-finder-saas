/**
 * Template-focused tests for verification and password-reset emails.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function loadService() {
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
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  global.fetch = ORIGINAL_FETCH;
  mock.restoreAll();
});

describe('transactional email templates', () => {
  it('verification email has correct subject, CTA, validity and personalized greeting', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.MAIL_FROM = 'noreply@example.com';
    let captured;
    mockFetch(async (_url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'v1' }) };
    });
    const { sendVerificationEmail } = loadService();
    const url = 'https://app.example/pages/verify-email.html?token=abc';
    const result = await sendVerificationEmail('user@example.com', url, 'Ana Silva');
    assert.equal(result.sent, true);
    assert.equal(captured.subject, 'Confirme o seu endereço de email | Maps Leads Finder');
    assert.ok(captured.textContent.includes(url));
    assert.ok(captured.textContent.includes('Olá, Ana Silva,'));
    assert.ok(captured.textContent.includes('24 horas'));
    assert.ok(captured.htmlContent.includes('Confirmar endereço de email'));
    assert.ok(captured.htmlContent.includes(url));
    assert.ok(captured.htmlContent.includes('24 horas'));
    assert.ok(captured.htmlContent.includes('Olá, Ana Silva,'));
  });

  it('password reset email has correct subject, CTA and 1 hour validity', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.MAIL_FROM = 'noreply@example.com';
    let captured;
    mockFetch(async (_url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'r1' }) };
    });
    const { sendPasswordResetEmail } = loadService();
    const url = 'https://app.example/pages/reset-password.html?token=xyz';
    const result = await sendPasswordResetEmail('user@example.com', url, 'Bruno');
    assert.equal(result.sent, true);
    assert.equal(captured.subject, 'Redefina a sua palavra-passe | Maps Leads Finder');
    assert.ok(captured.textContent.includes(url));
    assert.ok(captured.textContent.includes('Olá, Bruno,'));
    assert.ok(captured.textContent.includes('1 hora'));
    assert.ok(captured.htmlContent.includes('Redefinir palavra-passe'));
    assert.ok(captured.htmlContent.includes('1 hora'));
  });

  it('uses neutral greeting when name is missing', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.MAIL_FROM = 'noreply@example.com';
    let captured;
    mockFetch(async (_url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'n1' }) };
    });
    const { sendVerificationEmail } = loadService();
    await sendVerificationEmail('user@example.com', 'https://app.example/v?token=t');
    assert.match(captured.htmlContent, /Olá,/);
    assert.doesNotMatch(captured.htmlContent, /Olá, ,/);
  });

  it('escapes HTML special characters in user name', async () => {
    process.env.BREVO_API_KEY = 'k';
    process.env.MAIL_FROM = 'noreply@example.com';
    let captured;
    mockFetch(async (_url, options) => {
      captured = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ messageId: 'x1' }) };
    });
    const { sendVerificationEmail } = loadService();
    await sendVerificationEmail(
      'user@example.com',
      'https://app.example/v?token=t',
      '<script>alert(1)</script>'
    );
    assert.doesNotMatch(captured.htmlContent, /<script>alert\(1\)<\/script>/);
    assert.ok(captured.htmlContent.includes('<script>'));
  });
});
