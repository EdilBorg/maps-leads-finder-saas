/**
 * Admin-only diagnostic routes.
 * Temporary OSM connectivity probe — no arbitrary URLs, no SSRF.
 */

const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { clientIp } = require('../middleware/rateLimitKeys');
const { runOsmConnectivityDiagnostic } = require('../services/osmDiagnostics');

const router = express.Router();

const limitOsmDiag = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyFn: (req) =>
    `admin-osm-diag:${req.session && req.session.userId ? req.session.userId : clientIp(req)}`,
});

/**
 * GET /api/admin/diagnostics/osm
 * Sequential Nominatim + Overpass connectivity checks.
 */
router.get(
  '/diagnostics/osm',
  requireAuth,
  requireAdmin,
  limitOsmDiag,
  async (req, res) => {
    try {
      const payload = await runOsmConnectivityDiagnostic();
      return res.status(200).json(payload);
    } catch (err) {
      console.warn('[admin/diagnostics/osm] unexpected failure');
      return res.status(500).json({ error: 'Diagnóstico indisponível.' });
    }
  }
);

module.exports = router;
