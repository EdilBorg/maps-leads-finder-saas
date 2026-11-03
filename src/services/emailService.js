/**
 * Email service abstraction.
 * Configure SMTP via env. In development without SMTP, logs outbound messages.
 */

const { config } = require('../config/env');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  if (!host) return null;

  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    return transporter;
  } catch {
    return null;
  }
}

async function sendMail({ to, subject, text, html }) {
  const from = process.env.MAIL_FROM || 'noreply@mapsleadsfinder.local';
  const tx = getTransporter();

  if (tx) {
    await tx.sendMail({ from, to, subject, text, html });
    return { sent: true, mode: 'smtp' };
  }

  if (!config.isProduction) {
    console.info('[email:dev]', { to, subject, textPreview: String(text || '').slice(0, 200) });
  } else {
    console.warn('[email] SMTP not configured; message not sent');
  }
  return { sent: false, mode: 'log' };
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
