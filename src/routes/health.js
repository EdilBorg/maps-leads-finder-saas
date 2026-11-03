/**
 * Health check routes.
 * Used by monitoring and deployment platforms.
 *
 * Never exposes internal error messages, stack traces or database
 * connection details to the client.
 */

const express = require('express');
const { checkConnection } = require('../db/pool');
const { config } = require('../config/env');

const router = express.Router();

/**
 * GET /api/health
 * Returns basic application status.
 * Database connectivity is reported as a boolean only.
 * Internal error details are logged server-side, never returned to the client.
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

  try {
    const db = await checkConnection();
    response.database = {
      connected: true,
      latencyMs: db.latencyMs,
    };
  } catch (err) {
    // Log internal details only on the server
    console.warn('[health] Database check failed:', err.message);
    response.database = {
      connected: false,
    };
    // Do not include err.message, connection strings, or any credentials
  }

  res.status(200).json(response);
});

module.exports = router;
