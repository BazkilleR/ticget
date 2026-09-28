const { pool } = require('../src/db');
const { redis } = require('../src/redis');

// users cascades to bookings; events/zones are left for the tests that need them.
async function resetUsers() {
  await pool.query('TRUNCATE users CASCADE');
}

async function closeConnections() {
  await Promise.allSettled([pool.end(), redis.quit()]);
}

module.exports = { resetUsers, closeConnections };
