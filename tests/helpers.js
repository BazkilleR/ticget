const { pool } = require('../src/db');
const { redis } = require('../src/redis');

// users cascades to bookings; events/zones are left for the tests that need them.
async function resetUsers() {
  await pool.query('TRUNCATE users CASCADE');
}

// events cascades to zones and bookings. Restart ids so fixtures are predictable.
async function resetEvents() {
  await pool.query('TRUNCATE events RESTART IDENTITY CASCADE');
}

// Tests use their own Redis logical DB (see setup-env.js), so this never touches the dev cache.
async function flushCache() {
  await redis.flushdb();
}

async function closeConnections() {
  await Promise.allSettled([pool.end(), redis.quit()]);
}

module.exports = { resetUsers, resetEvents, flushCache, closeConnections };
