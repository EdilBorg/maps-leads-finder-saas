/**
 * Email service via Brevo Transactional API (HTTPS).
 * Does not use SMTP — suitable for hosts that block outbound 587/465.
 *
 * Env:
 *   BREVO_API_KEY   — required in production
 *   MAIL_FROM       — verified sender address in Brevo (required in production)
 *   MAIL_FROM_NAME  — display name (default: Maps Leads Finder)
 *
 * Security: never log recipients, subjects, message bodies, verification/reset
 * links, tokens, API keys, or arbitrary error properties.
 */

const { config } = require('../config/env');

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const REQUEST_TIMEOUT_MS = 15_000;

/** Minimal email shape check (does not replace provider-side validation). */
function isPlausibleEmail(value) {
  if (!value || typeof value !== 'string') return false;
  const s = value.trim();
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

function classifyProviderStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_unavailable';
  return 'rejected';
}

function safeBrevoErrorMeta(errBody) {
  if (!errBody || typeof errBody !== 'object') return {};
  const code = errBody.code || errBody.error || undefined;
  const meta = {};
  if (code && typeof code === 'string' && code.length <= 64) {
    meta.providerCode = code.replace(/[^a-zA-Z0-9_.-]/g, '');
  }
  return meta;
}

function isTimeoutError(err) {
  return Boolean(err && (err.name === 'TimeoutError' || err.name === 'AbortError'));
}

/** Escape user-controlled strings for HTML email bodies. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&#39;');
}

/** Attribute-safe href (allow only http/https absolute URLs). */
function safeHref(url) {
  const s = String(url || '').trim();
  if (/^https?:\/\//i.test(s)) return escapeHtml(s);
  return '#';
}

function greetingLine(userName) {
  const name = userName && String(userName).trim();
  if (name) return `Olá, ${name},`;
  return 'Olá,';
}

function buildEmailHtml({ title, greeting, intro, ctaLabel, actionUrl, validityNote, securityNote }) {
  const safeTitle = escapeHtml(title);
  const safeGreeting = escapeHtml(greeting);
  const safeIntro = escapeHtml(intro);
  const safeCta = escapeHtml(ctaLabel);
  const href = safeHref(actionUrl);
  const safeValidity = escapeHtml(validityNote);
  const safeSecurity = escapeHtml(securityNote);
  const plainUrl = escapeHtml(String(actionUrl || ''));

  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background-color:#08090a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#08090a;padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#0f1011;border:1px solid #23252a;border-radius:12px;">
        <tr>
          <td style="padding:28px 28px 8px 28px;text-align:center;">
            <div style="font-size:14px;font-weight:600;color:#ffffff;letter-spacing:-0.02em;">Maps Leads Finder</div>
          </td>
        </tr>
        <tr>
          <td style="padding:8px 28px 0 28px;">
            <p style="margin:0 0 12px 0;font-size:15px;line-height:1.5;color:#d0d6e0;">${safeGreeting}</p>
            <h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;font-weight:600;color:#ffffff;letter-spacing:-0.02em;">${safeTitle}</h1>
            <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#8a8f98;">${safeIntro}</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 28px 24px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#e4f222" style="border-radius:8px;">
                  <a href="${href}" target="_blank" rel="noopener noreferrer"
                     style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:600;color:#08090a;text-decoration:none;border-radius:8px;">
                    ${safeCta}
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px 20px 28px;">
            <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:#8a8f98;">${safeValidity}</p>
            <p style="margin:0 0 16px 0;font-size:12px;line-height:1.5;color:#8a8f98;">${safeSecurity}</p>
            <p style="margin:0 0 6px 0;font-size:11px;line-height:1.5;color:#6b7280;">Se o botão não funcionar, copie e cole este endereço no navegador:</p>
            <p style="margin:0;font-size:11px;line-height:1.5;color:#6b7280;word-break:break-all;">${plainUrl}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px;border-top:1px solid #23252a;text-align:center;">
            <p style="margin:0;font-size:11px;color:#6b7280;">Maps Leads Finder · ORXU</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

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
    console.info('[email:dev] Email not sent: BREVO_API_KEY absent', {
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
    if (isTimeoutError(err)) {
      console.error('[email] Brevo request timed out');
      throw new Error('Email provider timeout');
    }
    console.error('[email] Brevo request failed');
    throw new Error('Email provider request failed');
  }

  if (!response.ok) {
    let errBody = null;
    try {
      errBody = await response.json();
    } catch (_) {
      /* ignore */
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

async function sendVerificationEmail(to, verifyUrl, userName) {
  const greeting = greetingLine(userName);
  const subject = 'Confirme o seu endereço de email | Maps Leads Finder';
  const text = [
    greeting,
    '',
    'Confirme o seu email para activar o acesso à sua conta no Maps Leads Finder.',
    '',
    `Abrir link de confirmação (válido por 24 horas):`,
    String(verifyUrl),
    '',
    'Se não criou uma conta, ignore esta mensagem.',
    '',
    'Maps Leads Finder · ORXU',
  ].join('\n');

  const html = buildEmailHtml({
    title: 'Confirme o seu email',
    greeting,
    intro:
      'A confirmação do endereço de email é necessária para activar o acesso à sua conta no Maps Leads Finder.',
    ctaLabel: 'Confirmar endereço de email',
    actionUrl: verifyUrl,
    validityNote: 'Este link é válido durante 24 horas.',
    securityNote: 'Se não criou uma conta, pode ignorar esta mensagem com segurança.',
  });

  return sendMail({ to, subject, text, html });
}

async function sendPasswordResetEmail(to, resetUrl, userName) {
  const greeting = greetingLine(userName);
  const subject = 'Redefina a sua palavra-passe | Maps Leads Finder';
  const text = [
    greeting,
    '',
    'Recebemos um pedido para redefinir a palavra-passe da sua conta.',
    '',
    `Abrir link de redefinição (válido por 1 hora):`,
    String(resetUrl),
    '',
    'Se não pediu esta alteração, ignore esta mensagem.',
    '',
    'Maps Leads Finder · ORXU',
  ].join('\n');

  const html = buildEmailHtml({
    title: 'Redefina a sua palavra-passe',
    greeting,
    intro:
      'Recebemos um pedido para redefinir a palavra-passe da sua conta no Maps Leads Finder.',
    ctaLabel: 'Redefinir palavra-passe',
    actionUrl: resetUrl,
    validityNote: 'Este link é válido durante 1 hora.',
    securityNote: 'Se não pediu esta alteração, ignore esta mensagem com segurança.',
  });

  return sendMail({ to, subject, text, html });
}

module.exports = {
  sendMail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  escapeHtml,
};
