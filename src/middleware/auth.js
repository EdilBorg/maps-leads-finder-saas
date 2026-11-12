/**
 * Session-based auth middleware.
 */

const authService = require('../services/authService');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  return next();
}

function requireVerifiedEmail(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  if (!req.session.emailVerified) {
    return res.status(403).json({
      error: 'Email não verificado.',
      code: 'EMAIL_NOT_VERIFIED',
    });
  }
  return next();
}

async function loadUser(req, res, next) {
  try {
    if (req.session && req.session.userId) {
      const row = await authService.findUserById(req.session.userId);
      if (row && row.status === 'active') {
        req.user = authService.publicUser(row);
        req.session.emailVerified = Boolean(row.email_verified_at);
      } else {
        req.session.destroy(() => {});
        req.user = null;
      }
    }
  } catch (err) {
    return next(err);
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  // Role and verification must come from DB-backed req.user (loadUser).
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
  if (!req.user.emailVerified) {
    return res.status(403).json({
      error: 'Email não verificado.',
      code: 'EMAIL_NOT_VERIFIED',
    });
  }
  return next();
}

module.exports = {
  requireAuth,
  requireVerifiedEmail,
  requireAdmin,
  loadUser,
};
