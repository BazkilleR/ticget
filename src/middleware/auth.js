const jwt = require('jsonwebtoken');
const config = require('../config');
const { HttpError } = require('./error');

// Verifies "Authorization: Bearer <jwt>" and sets req.userId from the token's sub claim.
// This is the only place userId may come from; never trust one in the request body.
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'unauthorized', 'Missing or malformed bearer token'));
  }

  try {
    // Pin the algorithm so a token signed with "none" or another alg is rejected.
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || !payload.sub) {
      return next(new HttpError(401, 'unauthorized', 'Invalid token'));
    }
    req.userId = payload.sub;
    return next();
  } catch {
    return next(new HttpError(401, 'unauthorized', 'Invalid or expired token'));
  }
}

module.exports = { requireAuth };
