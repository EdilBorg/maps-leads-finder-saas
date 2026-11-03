/**
 * Centralized error handling middleware.
 * Must be registered after all routes.
 */

function notFoundHandler(req, res, next) {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
}

/**
 * Express error-handling middleware (4 arguments).
 */
function errorHandler(err, req, res, next) {
  // If headers already sent, delegate to default Express handler
  if (res.headersSent) {
    return next(err);
  }

  const status = err.status || err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  // Log server-side
  if (status >= 500) {
    console.error('[error]', {
      message: err.message,
      stack: err.stack,
      path: req.originalUrl,
      method: req.method,
    });
  } else {
    console.warn('[error]', {
      message: err.message,
      path: req.originalUrl,
      method: req.method,
      status,
    });
  }

  const payload = {
    error: err.name || 'Error',
    message: err.message || 'Internal Server Error',
  };

  // Expose stack only in non-production
  if (!isProduction && err.stack) {
    payload.stack = err.stack.split('\n').map((l) => l.trim());
  }

  // Optional: attach validation details if present
  if (err.details) {
    payload.details = err.details;
  }

  res.status(status).json(payload);
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
