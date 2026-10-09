const { pool } = require('../db');
const { HttpError } = require('./error');

// Use after requireAuth. Reads the role from the DB on every request instead of a JWT claim, so
// removing someone's admin role takes effect immediately rather than when their token expires.
async function requireAdmin(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    if (rows[0]?.role !== 'admin') {
      return next(new HttpError(403, 'forbidden', 'Admin access required'));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAdmin };
