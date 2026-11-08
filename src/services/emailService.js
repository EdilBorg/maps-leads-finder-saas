/**
 * Email service via Brevo Transactional API (HTTPS).
 * Does not use SMTP — suitable for hosts that block outbound 587/465.
 *
 * Env:
 *   BREVO_API_KEY   — required in production
 *   MAIL_FROM       — verified sender address in Brevo (required in production)
 *   MAIL_FROM_NAME  — display name (default: Maps Leads Finder)
 *
 * Security: never log recipients, message bodies, verification/reset links,
 * tokens, or API keys.
 */

const { config } = require('../config/env');

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 15_000;

/** Minimal email shape check (does not replace provider-side validation). */
function isPlausibleEmail(value) {
  if (!value || typeof value !== 'string') return false;
  const s = value.trim();
  // Basic RFC-ish check: local@domain with a dot in domain, no spaces.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

function getApiKey() {
  const key = process.env.BREVO_API_KEY;
  return key && String(key).trim() ? String(key).trim() : '';
}

function getSender() {
  const email = process.env.MAIL_FROM && String(process.env.MAIL_FROM).trim();
  const name =
    (process.env.MAIL_FROM_NAME && String(process.env.MAIL_FROM_NAME).trim()) ||
    'Maps Leads Finder';
  return { email: email || '', name };
}

/**
 * Map Brevo/HTTP status to a short technical category for logs only.
 * Never include request body, tokens, or API keys.
 */
function classifyProviderStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_unavailable';
  return 'rejected';
}

/**
 * Extract only safe fields from a Brevo error body for logging.
 * Drops message text that may echo back addresses or content.
 */
function safeBrevoErrorMeta(errBody) {
  if (!errBody || typeof errBody !== 'object') return {};
  const code = errBody.code || errBody.error || undefined;
  // Prefer short machine codes; do not forward free-form message strings
  // (Brevo sometimes echoes request fields into message).
  const meta = {};
  if (code && typeof code === 'string' && code.length <= 64) {
    meta.providerCode = code.replace(/[^a-zA-Z0-9_.-]/g, '');
  }
  return meta;
}

/**
 * @param {{ to: string, subject: string, text?: string, html?: string }}
 * @returns {Promise<{ sent: boolean, mode: string, messageId?: string }>
 */
async function sendMail({ to, subject, text, html }) {
  if (!to || !subject) {
    throw new Error('sendMail requires to and subject');
  }

  const apiKey = getApiKey();
  const sender = getSender();

  if (!apiKey) {
    if (config.isProduction) {
      console.error('[email] BREVO_API_KEY is not configured; message not sent');
      throw new Error('Email service is not configured');
    }
    // Dev simulation: no recipient, body, links, or tokens in logs.
    console.info('[email:dev] Email not sent: BREVO_API_KEY absent', {
      subject: String(subject),
      mode: 'log',
    });
    return { sent: false, mode: 'log' };
  }

  if (!sender.email || !isPlausibleEmail(sender.email)) {
    const msg = 'MAIL_FROM is not configured or is invalid';
    if (config.isProduction) {
      console.error(`[email] ${msg}; message not sent`);
      throw new Error(msg);
    }
    console.warn(`[email] ${msg}; falling back to log mode`);
    console.info('[email:dev] Email not sent: MAIL_FROM missing or invalid', {
      subject: String(subject),
      mode: 'log',
    });
    return { sent: false, mode: 'log' };
  }

  const body = {
    sender: { name: sender.name, email: sender.email },
    to: [{ email: String(to) }],
    subject: String(subject),
  };
  if (text) body.textContent = String(text);
  if (html) body.htmlContent = String(html);

  let response;
  try {
    response = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network / timeout — do not retry (request may already have been accepted).
    const isTimeout =
      err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    console.error(
      `[email] Brevo request ${isTimeout ? 'timed out' : 'failed'}:`,
      err && err.name ? err.name : 'Error'
    );
    throw new Error(isTimeout ? 'Email provider timeout' : 'Email provider request failed');
  }

  if (!response.ok) {
    let errBody = null;
    try {
      errBody = await response.json();
    } catch (_) {
      /* ignore parse errors */
    }
    const category = classifyProviderStatus(response.status);
    const meta = safeBrevoErrorMeta(errBody);
    console.error('[email] Brevo API rejected request', {
      status: response.status,
      category,
      ...meta,
    });
    throw new Error(`Email provider rejected request (${response.status})`);
  }

  let messageId;
  try {
    const data = await response.json();
    messageId = data && data.messageId ? String(data.messageId) : undefined;
  } catch (_) {
    /* success without body is still acceptance */
  }

  return { sent: true, mode: 'brevo-api', messageId };
}

async function sendVerificationEmail(to, verifyUrl) {
  return sendMail({
    to,
    subject: 'Confirme o seu email — Maps Leads Finder',
    text: `Confirme o seu email abrindo este link (válido por tempo limitado):\n\n${verifyUrl}\n\nSe não criou uma conta, ignore esta mensagem.`,
    html: `<p>Confirme o seu email:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>Se não criou uma conta, ignore esta mensagem.</p>`,
  });
}

async function sendPasswordResetEmail(to, resetUrl) {
  return sendMail({
    to,
    subject: 'Redefinição de palavra-passe — Maps Leads Finder',
    text: `Para redefinir a palavra-passe, abra este link (válido por tempo limitado):\n\n${resetUrl}\n\nSe não pediu esta alteração, ignore esta mensagem.`,
    html: `<p>Redefinir palavra-passe:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Se não pediu esta alteração, ignore esta mensagem.</p>`,
  });
}

module.exports = {
  sendMail,
  sendVerificationEmail,
  sendPasswordResetEmail,
};
