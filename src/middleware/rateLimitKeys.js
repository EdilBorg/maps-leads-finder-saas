/**
 * Shared rate-limit key builders.
 * Single source used by auth route limiters and test endpoints.
 * IP source is exclusively Express req.ip (never parse X-Forwarded-For manually).
 */

function clientIp(req) {
  return req.ip || null;
}

function loginRateKey(req) {
  return `login:${clientIp(req)}`;
}

function registerRateKey(req) {
  return `reg:${clientIp(req)}`;
}

function forgotRateKey(req) {
  return `forgot:${clientIp(req)}`;
}

function resendRateKey(req) {
  return `resend:${clientIp(req)}`;
}

module.exports = {
  clientIp,
  loginRateKey,
  registerRateKey,
  forgotRateKey,
  resendRateKey,
};
