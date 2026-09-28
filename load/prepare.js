// Prepares data for the k6 booking rush (load/booking-rush.js):
//   - a fresh "Load Test" event, on sale now, with one zone of LOAD_CAPACITY seats (default 100)
//   - LOAD_USERS users (default 1,000) named k6_0001..., each with a signed JWT
// Writes load/.data/rush.json (event/zone ids) and load/.data/tokens.json for k6 to read.
// Re-runnable: the previous load-test event, its bookings and the k6_ users are removed first.
//
// Tokens are signed directly with JWT_SECRET instead of calling /auth/login: 1,000 logins at bcrypt cost 12
// would take minutes, and in a real sale users are logged in well before it opens anyway.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const logger = require('../src/logger');
const { pool } = require('../src/db');
const { redis } = require('../src/redis');

const USERS = Number(process.env.LOAD_USERS || 1000);
const CAPACITY = Number(process.env.LOAD_CAPACITY || 100);
const EVENT_NAME = 'Load Test';
const OUT_DIR = path.join(__dirname, '.data');

async function main() {
  // Nobody can log in as a k6 user: the hash is of a random password that is thrown away.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

  const client = await pool.connect();
  let eventId;
  let zoneId;
  let users;
  try {
    await client.query('BEGIN');

    // Clean up the previous run.
    await client.query(
      `DELETE FROM bookings
        WHERE event_id IN (SELECT id FROM events WHERE name = $1)
           OR user_id IN (SELECT id FROM users WHERE username LIKE 'k6\\_%')`,
      [EVENT_NAME],
    );
    await client.query('DELETE FROM zones WHERE event_id IN (SELECT id FROM events WHERE name = $1)', [EVENT_NAME]);
    await client.query('DELETE FROM events WHERE name = $1', [EVENT_NAME]);
    await client.query(`DELETE FROM users WHERE username LIKE 'k6\\_%'`);

    const event = await client.query(
      `INSERT INTO events (name, venue, starts_at, sale_opens_at)
       VALUES ($1, 'k6 Arena', now() + interval '30 days', now() - interval '1 minute')
       RETURNING id`,
      [EVENT_NAME],
    );
    eventId = event.rows[0].id;

    const zone = await client.query(
      `INSERT INTO zones (event_id, name, price, capacity) VALUES ($1, 'Rush', 1000, $2) RETURNING id`,
      [eventId, CAPACITY],
    );
    zoneId = zone.rows[0].id;

    const inserted = await client.query(
      `INSERT INTO users (username, password_hash)
       SELECT 'k6_' || lpad(i::text, 4, '0'), $2 FROM generate_series(1, $1) AS i
       RETURNING id`,
      [USERS, passwordHash],
    );
    users = inserted.rows;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Long enough to cover the run; each token is only usable against this environment's JWT_SECRET.
  const tokens = users.map((u) =>
    jwt.sign({}, config.jwtSecret, { algorithm: 'HS256', subject: u.id, expiresIn: '2h' }),
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'rush.json'), JSON.stringify({ eventId, zoneId, capacity: CAPACITY, users: USERS }));
  fs.writeFileSync(path.join(OUT_DIR, 'tokens.json'), JSON.stringify(tokens));

  logger.info({ eventId, zoneId, capacity: CAPACITY, users: USERS, outDir: OUT_DIR }, 'load test data ready');
}

main()
  .then(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
  })
  .catch(async (err) => {
    logger.error({ err }, 'load prepare failed');
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(1);
  });
