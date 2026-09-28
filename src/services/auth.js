const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db');
const { HttpError } = require('../middleware/error');

const BCRYPT_COST = 12;
const TOKEN_TTL = '1h';
const PG_UNIQUE_VIOLATION = '23505';

// Compared against when the username does not exist, so a miss costs the same bcrypt time
// as a wrong password and response timing does not reveal which usernames are registered.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);

async function register(username, password) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, passwordHash],
    );
    return rows[0];
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new HttpError(409, 'username_taken', 'Username is already registered');
    }
    throw err;
  }
}

async function login(username, password) {
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE username = $1', [
    username,
  ]);
  const user = rows[0];

  const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !match) {
    throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
  }

  const token = jwt.sign({}, config.jwtSecret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: TOKEN_TTL,
  });
  return { token };
}

module.exports = { register, login };
