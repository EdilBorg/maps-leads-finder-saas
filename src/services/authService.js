/**
 * Authentication domain service.
 * Passwords: Argon2id. Tokens: random + SHA-256 hash stored only.
 * Access requires email_verified_at to be set.
 */

const { getPool } = require('../db/pool');
const {
  normalizeEmail,
  isValidEmail,
  isValidPassword,
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
} = require('../utils/crypto');
const emailService = require('./emailService');
const { config } = require('../config/env');

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    emailVerified: Boolean(row.email_verified_at),
    freeSearchUsed: Boolean(row.free_search_used),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

async function findUserByNormalizedEmail(emailNormalized, client) {
  const db = client || getPool();
  const { rows } = await db.query(
    'SELECT * FROM users WHERE email_normalized = $1 LIMIT 1',
    [emailNormalized]
  );
  return rows[0] || null;
}

async function findUserById(id, client) {
  const db = client || getPool();
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function register({ name, email, password, passwordConfirm, appUrl }) {
  const errors = [];
  const trimmedName = String(name || '').trim();
  if (!trimmedName || trimmedName.length < 2 || trimmedName.length > 100) {
    errors.push('Nome inválido.');
  }
  if (!isValidEmail(email)) {
    errors.push('Email inválido.');
  }
  if (!isValidPassword(password)) {
    errors.push('A palavra-passe deve ter entre 8 e 128 caracteres.');
  }
  if (password !== passwordConfirm) {
    errors.push('A confirmação da palavra-passe não coincide.');
  }
  if (errors.length) {
    return { ok: false, code: 'VALIDATION', errors };
  }

  const emailNormalized = normalizeEmail(email);
  const existing = await findUserByNormalizedEmail(emailNormalized);
  if (existing) {
    return { ok: false, code: 'DUPLICATE', errors: ['Não foi possível concluir o registo.'] };
  }

  const passwordHash = await hashPassword(password);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO users (email, email_normalized, password_hash, name, role, status)
       VALUES ($1, $2, $3, $4, 'user', 'active')
       RETURNING *`,
      [email.trim(), emailNormalized, passwordHash, trimmedName]
    );
    const user = rows[0];
    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + VERIFY_TTL_MS);
    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );
    await client.query('COMMIT');

    const base = appUrl || config.appUrl || 'http://localhost:3000';
    const verifyUrl = `${base}/pages/verify-email.html?token=${encodeURIComponent(rawToken)}`;
    let emailSent = false;
    try {
      const mailResult = await emailService.sendVerificationEmail(
        user.email,
        verifyUrl,
        user.name
      );
      emailSent = Boolean(mailResult && mailResult.sent);
    } catch (mailErr) {
      console.error('[auth] verification email failed after register:', mailErr.message);
      emailSent = false;
    }

    return {
      ok: true,
      user: publicUser(user),
      emailSent,
      ...(config.isProduction ? {} : { _testVerifyToken: rawToken }),
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err.code === '23505') {
      return { ok: false, code: 'DUPLICATE', errors: ['Não foi possível concluir o registo.'] };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function countRecentFailedLogins(emailNormalized) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS c FROM login_attempts
     WHERE email_normalized = $1 AND success = FALSE AND created_at >= $2`,
    [emailNormalized, since]
  );
  return rows[0].c;
}

async function countRecentFailedLoginsByIp(ip) {
  if (!ip) return 0;
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int AS c FROM login_attempts
     WHERE ip = $1 AND success = FALSE AND created_at >= $2`,
    [ip, since]
  );
  return rows[0].c;
}

async function recordLoginAttempt(emailNormalized, ip, success) {
  await getPool().query(
    `INSERT INTO login_attempts (email_normalized, ip, success) VALUES ($1, $2, $3)`,
    [emailNormalized, ip || null, success]
  );
}

async function login({ email, password, ip }) {
  if (!isValidEmail(email) || typeof password !== 'string') {
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }
  const emailNormalized = normalizeEmail(email);
  const failedEmail = await countRecentFailedLogins(emailNormalized);
  const failedIp = ip ? await countRecentFailedLoginsByIp(ip) : 0;
  if (failedEmail >= MAX_LOGIN_ATTEMPTS || failedIp >= MAX_LOGIN_ATTEMPTS) {
    return { ok: false, code: 'RATE_LIMITED' };
  }

  const user = await findUserByNormalizedEmail(emailNormalized);
  let match = false;
  if (user) {
    match = await verifyPassword(user.password_hash, password);
  } else {
    await verifyPassword(
      '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      password
    ).catch(() => false);
  }

  if (!user || !match) {
    await recordLoginAttempt(emailNormalized, ip, false);
    return { ok: false, code: 'INVALID_CREDENTIALS' };
  }
  if (user.status === 'suspended') {
    await recordLoginAttempt(emailNormalized, ip, false);
    return { ok: false, code: 'SUSPENDED' };
  }

  // Credentials are valid but the account cannot access the app until verified.
  if (!user.email_verified_at) {
    return { ok: false, code: 'EMAIL_NOT_VERIFIED' };
  }

  await recordLoginAttempt(emailNormalized, ip, true);
  await getPool().query('UPDATE users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [
    user.id,
  ]);
  return { ok: true, user: publicUser(user) };
}

async function verifyEmail(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
  const tokenHash = hashToken(rawToken);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM email_verification_tokens
       WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'INVALID_TOKEN' };
    }
    if (row.used_at) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'TOKEN_USED' };
    }
    if (new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'TOKEN_EXPIRED' };
    }
    await client.query(
      `UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1`,
      [row.id]
    );
    await client.query(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [row.user_id]
    );
    await client.query('COMMIT');
    const user = await findUserById(row.user_id);
    return { ok: true, user: publicUser(user) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function resendVerification({ email, appUrl }) {
  if (!isValidEmail(email)) {
    return { ok: true };
  }
  const emailNormalized = normalizeEmail(email);
  const user = await findUserByNormalizedEmail(emailNormalized);
  if (!user || user.email_verified_at) {
    return { ok: true };
  }

  const { rows } = await getPool().query(
    `SELECT created_at FROM email_verification_tokens
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  if (rows[0] && Date.now() - new Date(rows[0].created_at).getTime() < RESEND_COOLDOWN_MS) {
    return { ok: false, code: 'RATE_LIMITED' };
  }

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS);
  await getPool().query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt]
  );
  const base = appUrl || config.appUrl || 'http://localhost:3000';
  const verifyUrl = `${base}/pages/verify-email.html?token=${encodeURIComponent(rawToken)}`;
  let emailSent = false;
  try {
    const mailResult = await emailService.sendVerificationEmail(
      user.email,
      verifyUrl,
      user.name
    );
    emailSent = Boolean(mailResult && mailResult.sent);
  } catch (mailErr) {
    console.error('[auth] resend verification email failed:', mailErr.message);
  }
  return {
    ok: true,
    emailSent,
    ...(config.isProduction ? {} : { _testVerifyToken: rawToken }),
  };
}

async function requestPasswordReset({ email, appUrl }) {
  if (!isValidEmail(email)) {
    return { ok: true };
  }
  const emailNormalized = normalizeEmail(email);
  const user = await findUserByNormalizedEmail(emailNormalized);
  if (!user || user.status === 'suspended') {
    return { ok: true };
  }

  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await getPool().query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, tokenHash, expiresAt]
  );
  const base = appUrl || config.appUrl || 'http://localhost:3000';
  const resetUrl = `${base}/pages/reset-password.html?token=${encodeURIComponent(rawToken)}`;
  try {
    await emailService.sendPasswordResetEmail(user.email, resetUrl, user.name);
  } catch (mailErr) {
    console.error('[auth] password reset email failed:', mailErr.message);
  }
  return {
    ok: true,
    ...(config.isProduction ? {} : { _testResetToken: rawToken }),
  };
}

async function resetPassword({ token, password, passwordConfirm }) {
  if (!isValidPassword(password) || password !== passwordConfirm) {
    return { ok: false, code: 'VALIDATION', errors: ['Palavra-passe inválida ou não coincide.'] };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
  const tokenHash = hashToken(token);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'INVALID_TOKEN' };
    }
    if (row.used_at) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'TOKEN_USED' };
    }
    if (new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'TOKEN_EXPIRED' };
    }
    const passwordHash = await hashPassword(password);
    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, row.user_id]
    );
    await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [row.id]);
    await client.query(
      `UPDATE password_reset_tokens SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
      [row.user_id]
    );
    await client.query(
      `DELETE FROM session WHERE sess::text LIKE $1`,
      [`%"userId":"${row.user_id}"%`]
    );
    await client.query('COMMIT');
    return { ok: true, userId: row.user_id };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function revokeUserSessions(userId) {
  await getPool().query(
    `DELETE FROM session WHERE sess::text LIKE $1`,
    [`%"userId":"${userId}"%`]
  );
}

module.exports = {
  publicUser,
  findUserById,
  findUserByNormalizedEmail,
  register,
  login,
  verifyEmail,
  resendVerification,
  requestPasswordReset,
  resetPassword,
  revokeUserSessions,
  MAX_LOGIN_ATTEMPTS,
};
