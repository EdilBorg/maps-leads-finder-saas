/**
 * Health check routes.
 * Used by monitoring and deployment platforms.
 */

const express = require('express');
const { checkConnection } = require('../db/pool');
const { config } = require('../config/env');

const router = express.Router();

/**
 * GET /api/health
 * Returns basic application status.
 * Database connectivity is reported when available, without failing the endpoint
 * if the database is not yet configured (this stage has no required tables).
 */
router.get('/health', async (req, res) => {
  const response = {
    status: 'ok',
    service: 'maps-leads-finder-saas',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    environment: config.nodeEnv,
    uptimeSeconds: Math.floor(process.uptime()),
  };

  // Attempt a lightweight DB check; do not fail the whole health endpoint
  // if the database is unreachable during early setup.
  try {
    const db = await checkConnection();
    response.database = {
      connected: true,
      latencyMs: db.latencyMs,
    };
  } catch (err) {
    response.database = {
      connected: false,
      error: err.message,
    };
    // Keep overall status "ok" for process health; database readiness
    // will be required in later stages once migrations exist.
  }

  res.status(200).json(response);
});

module.exports = router;
