// src/middleware/requestId.middleware.js
//
// Tags every incoming request with a unique ID, so an engineer can trace
// exactly what happened to one request across every log line it touches -
// "search for this one ID" instead of guessing from timestamps and hoping
// nothing else happened at the same moment. This is what makes "a
// customer says their money disappeared - what actually happened?"
// answerable from logs alone.
//
// If the request already arrives with an x-request-id header (e.g.
// forwarded by a load balancer, reverse proxy, or another internal
// service), that value is reused instead of generating a new one, so a
// single request keeps the same ID across every hop it makes.

const crypto = require('crypto');
const logger = require('../utils/logger');

function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('x-request-id', req.id);

  // A logger pre-tagged with this request's ID - use `req.log` instead of
  // the plain `logger` import anywhere inside a request handler, and the
  // ID shows up on that log line automatically, with no extra typing.
  req.log = logger.child({ requestId: req.id });

  next();
}

module.exports = requestId;
