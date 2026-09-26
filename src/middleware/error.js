const logger = require('../logger');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function notFound(req, res) {
  res.status(404).json({ error: 'not_found', message: 'Route not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }

  // Malformed JSON body from express.json()
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON' });
  }

  (req.log || logger).error({ err }, 'unhandled error');
  return res.status(500).json({ error: 'internal_error', message: 'Internal server error' });
}

module.exports = { HttpError, notFound, errorHandler };
