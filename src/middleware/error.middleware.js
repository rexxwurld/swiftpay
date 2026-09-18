// src/middleware/error.middleware.js
const logger = require('../utils/logger');

function notFound(req, res) {
  res.status(404).json({ status: false, message: 'route_not_found' });
}

function errorHandler(err, req, res, next) {
  logger.error({ err, path: req.originalUrl, method: req.method }, '[errorHandler] unhandled request error');
  res.status(err.status || 500).json({
    status: false,
    message: err.message || 'internal_server_error',
  });
}

module.exports = { notFound, errorHandler };
