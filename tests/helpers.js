const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const { ReceiveMessageCommand, DeleteMessageBatchCommand } = require('@aws-sdk/client-sqs');
const config = require('../src/config');
const { pool } = require('../src/db');
const { redis } = require('../src/redis');
const { sqs } = require('../src/sqs');

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
  sqs.destroy();
  await Promise.allSettled([pool.end(), redis.quit()]);
}

// ---- fixtures -------------------------------------------------------------------------------------------

// Intervals are relative to now() so fixtures never go stale, e.g. insertEvent('X', '30 days').
async function insertEvent(name, startsIn, saleOpensIn = '-1 day') {
  const { rows } = await pool.query(
    `INSERT INTO events (name, venue, starts_at, sale_opens_at)
     VALUES ($1, 'Test Venue', now() + $2::interval, now() + $3::interval)
     RETURNING id`,
    [name, startsIn, saleOpensIn],
  );
  return rows[0].id;
}

async function insertZone(eventId, name, { price = 1000, capacity = 10, reserved = 0 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO zones (event_id, name, price, capacity, reserved)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [eventId, name, price, capacity, reserved],
  );
  return rows[0].id;
}

// Inserts a booking row directly. It does not touch zones.reserved: set that on the zone to match.
// expiresIn is an interval relative to now(), negative for a hold that has already run out.
async function insertBooking({ userId, eventId, zoneId, quantity = 1, status = 'PENDING', failReason = null, expiresIn = '10 minutes' }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO bookings (id, request_id, user_id, event_id, zone_id, quantity, status, fail_reason, expires_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, now() + $8::interval)`,
    [id, userId, eventId, zoneId, quantity, status, failReason, expiresIn],
  );
  return id;
}

// Inserts a user directly and signs a token for it, skipping bcrypt so tests stay fast.
async function createUser(username, { role = 'user' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'not-a-real-hash', $2) RETURNING id`,
    [username, role],
  );
  const userId = rows[0].id;
  const token = jwt.sign({}, config.jwtSecret, { algorithm: 'HS256', subject: userId, expiresIn: '1h' });
  return { userId, token };
}

// ---- SQS (test queue, see setup-env.js) ------------------------------------------------------------------

// Receives and deletes every message currently in the queue. Returns them with parsed bodies.
async function drainQueue({ waitSeconds = 0 } = {}) {
  const received = [];
  for (;;) {
    const res = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: config.sqsBookingQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: received.length ? 0 : waitSeconds,
        AttributeNames: ['All'],
      }),
    );
    const messages = res.Messages || [];
    if (messages.length === 0) return received;

    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: config.sqsBookingQueueUrl,
        Entries: messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }),
    );
    for (const m of messages) {
      received.push({ body: JSON.parse(m.Body), attributes: m.Attributes });
    }
  }
}

module.exports = {
  resetUsers,
  resetEvents,
  flushCache,
  closeConnections,
  insertEvent,
  insertZone,
  insertBooking,
  createUser,
  drainQueue,
};
