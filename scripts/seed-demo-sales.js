// Fills the sales dashboard with believable data: paid bookings (with e-tickets) spread over the last
// 7 days on events that are on sale. Run after `npm run seed`. Each run adds more sales.
// Seats are taken with the same conditional UPDATE the worker uses, so a zone can never be oversold.
// Event 1 is left alone: its tiny VIP zone and the k6 zone are for manual and load testing.
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const config = require('../src/config');
const { pool } = require('../src/db');
const logger = require('../src/logger');
const cache = require('../src/services/cache');

const USERS = 150;
const MAX_TICKETS_PER_ZONE = 300;
const DAYS = 7;

const random = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

async function createDemoUsers() {
  // One real hash for all of them, of a password nobody knows, so these accounts cannot be logged into.
  const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash)
     SELECT 'demo_' || to_char(g, 'FM000') || '_' || substr(md5(random()::text), 1, 4), $1
       FROM generate_series(1, $2) AS g
     RETURNING id`,
    [hash, USERS],
  );
  return rows.map((r) => r.id);
}

async function sellZone(client, zone, users, perUserEvent) {
  const target = Math.min(MAX_TICKETS_PER_ZONE, Math.floor(zone.capacity * (0.1 + Math.random() * 0.5)));
  let sold = 0;
  for (let attempts = 0; sold < target && attempts < target * 2; attempts += 1) {
    const userId = users[random(0, users.length - 1)];
    const key = `${userId}:${zone.event_id}`;
    const quantity = Math.min(random(1, 4), config.maxTicketsPerUser - (perUserEvent.get(key) ?? 0), target - sold);
    if (quantity <= 0) continue;

    const reserved = await client.query(
      `UPDATE zones SET reserved = reserved + $2 WHERE id = $1 AND reserved + $2 <= capacity RETURNING price`,
      [zone.id, quantity],
    );
    if (reserved.rowCount === 0) break; // full

    const id = crypto.randomUUID();
    const minutesAgo = random(5, DAYS * 24 * 60);
    await client.query(
      `INSERT INTO bookings (id, request_id, user_id, event_id, zone_id, quantity, status, unit_price,
                             created_at, updated_at, paid_at, expires_at)
       SELECT $1, $1, $2, $3, $4, $5, 'CONFIRMED', $6, t - interval '3 minutes', t, t, t + interval '7 minutes'
         FROM (SELECT now() - make_interval(mins => $7) AS t) x`,
      [id, userId, zone.event_id, zone.id, quantity, reserved.rows[0].price, minutesAgo],
    );
    await client.query(
      `INSERT INTO tickets (booking_id, seq, code)
       SELECT $1, g, encode(gen_random_bytes(16), 'hex') FROM generate_series(1, $2) AS g`,
      [id, quantity],
    );
    perUserEvent.set(key, (perUserEvent.get(key) ?? 0) + quantity);
    sold += quantity;
  }
  return sold;
}

async function main() {
  if (config.nodeEnv === 'production') throw new Error('refusing to seed demo sales: NODE_ENV=production');

  const users = await createDemoUsers();
  const { rows: zones } = await pool.query(
    `SELECT z.id, z.event_id, z.capacity
       FROM zones z JOIN events e ON e.id = z.event_id
      WHERE e.id <> 1 AND e.sale_opens_at <= now() AND e.starts_at > now()
      ORDER BY z.id`,
  );

  const perUserEvent = new Map();
  let total = 0;
  for (const zone of zones) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      total += await sellZone(client, zone, users, perUserEvent);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const touched = [...new Set(zones.map((z) => z.event_id))].map(cache.keys.eventZones);
  if (touched.length) await cache.del(...touched);
  logger.info({ users: users.length, zones: zones.length, tickets: total }, 'seed-demo-sales: done');
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    logger.error({ err }, 'seed-demo-sales: failed');
    await pool.end();
    process.exit(1);
  })
  .finally(() => require('../src/redis').redis.disconnect());
