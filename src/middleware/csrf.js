/**
 * Synchronizer-token CSRF protection for cookie-based sessions.
 * Token is stored in the session (server-side) and must be sent as
 * X-CSRF-Token (or body._csrf) on state-changing requests.
 */

const crypto = require('crypto');

function ensureCsrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  }
  return req.session.csrfToken;
}

function csrfTokenHandler(req, res) {
  const token = ensureCsrfToken(req);
  if (!token) {
    return res.status(500).json({ error: 'Sessão indisponível.' });
  }
  req.session.save((err) => {
    if (err) {
      return res.status(500).json({ error: 'Não foi possível preparar CSRF.' });
    }
    return res.json({ csrfToken: token });
  });
}

function requireCsrf(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return next();
  }

  if (!req.session || !req.session.csrfToken) {
    return res.status(403).json({ error: 'Token CSRF em falta ou sessão inválida.', code: 'CSRF' });
  }

  const header = req.get('x-csrf-token') || req.get('X-CSRF-Token');
  const bodyToken = req.body && (req.body._csrf || req.body.csrfToken);
  const provided = header || bodyToken;

  if (!provided || typeof provided !== 'string') {
    return res.status(403).json({ error: 'Token CSRF em falta.', code: 'CSRF' });
  }

  const expected = Buffer.from(req.session.csrfToken);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(403).json({ error: 'Token CSRF inválido.', code: 'CSRF' });
  }

  return next();
}

module.exports = {
  ensureCsrfToken,
  csrfTokenHandler,
  requireCsrf,
};
