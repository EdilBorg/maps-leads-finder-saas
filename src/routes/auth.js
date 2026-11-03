/**
 * Auth API routes.
 * Never returns password hashes or raw tokens.
 */

const express = require('express');
const authService = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { config } = require('../config/env');

const router = express.Router();

function clientIp(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
}

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, passwordConfirm } = req.body || {};
    const result = await authService.register({
      name,
      email,
      password,
      passwordConfirm,
      appUrl: config.appUrl,
    });
    if (!result.ok) {
      const status = result.code === 'DUPLICATE' ? 409 : 400;
      return res.status(status).json({
        error: result.errors?.[0] || 'Registo inválido.',
        code: result.code,
        errors: result.errors,
      });
    }
    return res.status(201).json({
      message: 'Conta criada. Verifique o seu email para ativar a conta.',
      user: result.user,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const result = await authService.login({
      email,
      password,
      ip: clientIp(req),
    });
    if (!result.ok) {
      if (result.code === 'RATE_LIMITED') {
        return res.status(429).json({ error: 'Demasiadas tentativas. Tente mais tarde.' });
      }
      if (result.code === 'SUSPENDED') {
        return res.status(403).json({ error: 'Conta suspensa.' });
      }
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = result.user.id;
      req.session.emailVerified = result.user.emailVerified;
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        return res.json({ user: result.user });
      });
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res, next) => {
  if (!req.session) {
    return res.json({ message: 'Sessão terminada.' });
  }
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie(config.sessionCookieName || 'connect.sid');
    return res.json({ message: 'Sessão terminada.' });
  });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const row = await authService.findUserById(req.session.userId);
    if (!row || row.status !== 'active') {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    return res.json({ user: authService.publicUser(row) });
  } catch (err) {
    return next(err);
  }
});

router.post('/verify-email', async (req, res, next) => {
  try {
    const token = (req.body && req.body.token) || req.query.token;
    const result = await authService.verifyEmail(token);
    if (!result.ok) {
      const map = {
        INVALID_TOKEN: 'Token inválido.',
        TOKEN_USED: 'Token já utilizado.',
        TOKEN_EXPIRED: 'Token expirado.',
      };
      return res.status(400).json({ error: map[result.code] || 'Verificação falhou.', code: result.code });
    }
    if (req.session && req.session.userId === result.user.id) {
      req.session.emailVerified = true;
    }
    return res.json({ message: 'Email verificado com sucesso.', user: result.user });
  } catch (err) {
    return next(err);
  }
});

router.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const result = await authService.resendVerification({ email, appUrl: config.appUrl });
    if (result.code === 'RATE_LIMITED') {
      return res.status(429).json({ error: 'Aguarde antes de solicitar outro email.' });
    }
    return res.json({ message: 'Se a conta existir e o email não estiver verificado, enviámos instruções.' });
  } catch (err) {
    return next(err);
  }
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body || {};
    await authService.requestPasswordReset({ email, appUrl: config.appUrl });
    return res.json({
      message: 'Se o email estiver associado a uma conta, enviámos instruções de recuperação.',
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password, passwordConfirm } = req.body || {};
    const result = await authService.resetPassword({ token, password, passwordConfirm });
    if (!result.ok) {
      if (result.code === 'VALIDATION') {
        return res.status(400).json({ error: result.errors?.[0] || 'Dados inválidos.', code: result.code });
      }
      const map = {
        INVALID_TOKEN: 'Token inválido.',
        TOKEN_USED: 'Token já utilizado.',
        TOKEN_EXPIRED: 'Token expirado.',
      };
      return res.status(400).json({ error: map[result.code] || 'Redefinição falhou.', code: result.code });
    }
    await authService.revokeUserSessions(result.userId);
    return res.json({ message: 'Palavra-passe atualizada. Inicie sessão novamente.' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
