/**
 * Auth API routes.
 * Never returns password hashes or raw tokens in production.
 */

const express = require('express');
const authService = require('../services/authService');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf, csrfTokenHandler } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');
const {
  clientIp,
  loginRateKey,
  registerRateKey,
  forgotRateKey,
  resendRateKey,
} = require('../middleware/rateLimitKeys');
const { config } = require('../config/env');

const router = express.Router();

const limitRegister = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyFn: registerRateKey,
});

const limitLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyFn: loginRateKey,
});

const limitForgot = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyFn: forgotRateKey,
});

const limitResend = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyFn: resendRateKey,
});

router.get('/csrf', csrfTokenHandler);

router.post('/register', limitRegister, requireCsrf, async (req, res, next) => {
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

    // Never create a session on register — email must be verified first.
    const payload = {
      user: result.user,
      emailSent: result.emailSent,
      message: result.emailSent
        ? 'Conta criada. Verifique o seu email para ativar a conta.'
        : 'Conta criada, mas o email de verificação não pôde ser enviado. Use “Reenviar verificação”.',
    };
    if (!config.isProduction && result._testVerifyToken) {
      payload._testVerifyToken = result._testVerifyToken;
    }
    return res.status(201).json(payload);
  } catch (err) {
    return next(err);
  }
});

router.post('/login', limitLogin, requireCsrf, async (req, res, next) => {
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
        return res.status(403).json({ error: 'Conta suspensa.', code: 'SUSPENDED' });
      }
      if (result.code === 'EMAIL_NOT_VERIFIED') {
        return res.status(403).json({
          error: 'Este endereço de email ainda não foi confirmado.',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = result.user.id;
      req.session.emailVerified = result.user.emailVerified;
      req.session.csrfToken = require('crypto').randomBytes(32).toString('base64url');
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        return res.json({
          user: result.user,
          csrfToken: req.session.csrfToken,
        });
      });
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', requireCsrf, (req, res, next) => {
  if (!req.session) {
    return res.json({ message: 'Sessão terminada.' });
  }
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie(config.sessionCookieName || 'mlf.sid');
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

router.post('/verify-email', requireCsrf, async (req, res, next) => {
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

router.post('/resend-verification', limitResend, requireCsrf, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const result = await authService.resendVerification({ email, appUrl: config.appUrl });
    if (result.code === 'RATE_LIMITED') {
      return res.status(429).json({ error: 'Aguarde antes de solicitar outro email.' });
    }
    const payload = {
      message: 'Se a conta existir e o email não estiver verificado, enviámos instruções.',
    };
    if (!config.isProduction && result._testVerifyToken) {
      payload._testVerifyToken = result._testVerifyToken;
    }
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

router.post('/forgot-password', limitForgot, requireCsrf, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const result = await authService.requestPasswordReset({ email, appUrl: config.appUrl });
    const payload = {
      message: 'Se o email estiver associado a uma conta, enviámos instruções de recuperação.',
    };
    if (!config.isProduction && result._testResetToken) {
      payload._testResetToken = result._testResetToken;
    }
    return res.json(payload);
  } catch (err) {
    return next(err);
  }
});

router.post('/reset-password', requireCsrf, async (req, res, next) => {
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
    return res.json({ message: 'Palavra-passe atualizada. Inicie sessão novamente.' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
