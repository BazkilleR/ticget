const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const { z } = require('zod');
const config = require('../config');
const logger = require('../logger');
const { pool } = require('../db');
const { sqs } = require('../sqs');
const { HttpError } = require('../middleware/error');
const cache = require('./cache');

// ---------------------------------------------------------------------------------------------------------
// API side: accept a booking request and queue it. The worker (Phase 5) decides whether it succeeds.
// ---------------------------------------------------------------------------------------------------------

async function requestBooking(userId, { eventId, zoneId, quantity, requestId }) {
  const { rows } = await pool.query(
    `SELECT e.sale_opens_at <= now() AS "saleOpen",
            e.starts_at > now()      AS "notStarted"
       FROM zones z
       JOIN events e ON e.id = z.event_id
      WHERE z.id = $1 AND z.event_id = $2`,
    [zoneId, eventId],
  );
  const zone = rows[0];
  if (!zone) throw new HttpError(404, 'zone_not_found', 'Zone not found in this event');
  if (!zone.saleOpen) throw new HttpError(409, 'sale_not_open', 'Sale has not opened yet');
  if (!zone.notStarted) throw new HttpError(409, 'sale_closed', 'Event has already started');

  // bookingId = requestId, so a client retry with the same requestId maps to the same booking.
  const message = {
    bookingId: requestId,
    requestId,
    userId,
    eventId,
    zoneId,
    quantity,
    requestedAt: new Date().toISOString(),
  };

  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: config.sqsBookingQueueUrl,
        MessageBody: JSON.stringify(message),
        // One group per zone: SQS FIFO hands a zone's messages to workers one at a time, in order.
        MessageGroupId: `zone-${zoneId}`,
        // SQS drops a resend with the same id within 5 minutes; the worker's request_id check covers the rest.
        MessageDeduplicationId: requestId,
      }),
    );
  } catch (err) {
    logger.error({ err, bookingId: requestId }, 'booking enqueue failed');
    throw new HttpError(503, 'queue_unavailable', 'Could not accept booking, please retry');
  }

  logger.info({ bookingId: requestId, eventId, zoneId, quantity }, 'booking queued');
  return { bookingId: requestId, status: 'QUEUED' };
}

// ---------------------------------------------------------------------------------------------------------
// Reads. Every query is scoped by user_id (rule 2). A PENDING booking past its hold is reported as EXPIRED
// even before the worker or cleanup job updates the row (rule 6).
// ---------------------------------------------------------------------------------------------------------

const BOOKING_SELECT = `
  SELECT b.id         AS "bookingId",
         b.event_id   AS "eventId",
         e.name       AS "eventName",
         b.zone_id    AS "zoneId",
         z.name       AS "zoneName",
         b.quantity,
         CASE WHEN b.status = 'PENDING' AND b.expires_at < now() THEN 'EXPIRED' ELSE b.status END AS status,
         b.fail_reason AS "failReason",
         b.expires_at  AS "expiresAt",
         b.created_at  AS "createdAt"
    FROM bookings b
    JOIN events e ON e.id = b.event_id
    JOIN zones z  ON z.id = b.zone_id`;

// Not in the DB yet means the worker has not processed it (or it belongs to someone else, which must look
// the same so ids of other users' bookings are not revealed).
async function getBooking(userId, bookingId) {
  const { rows } = await pool.query(`${BOOKING_SELECT} WHERE b.id = $1 AND b.user_id = $2`, [
    bookingId,
    userId,
  ]);
  return rows[0] || { bookingId, status: 'QUEUED' };
}

async function listMyBookings(userId) {
  const { rows } = await pool.query(
    `${BOOKING_SELECT} WHERE b.user_id = $1 ORDER BY b.created_at DESC, b.id`,
    [userId],
  );
  return rows;
}

// ---------------------------------------------------------------------------------------------------------
// Worker side: process one queued booking request. Everything happens in a single transaction, so a crash
// or error at any point leaves no partial state and the message can simply be retried.
// ---------------------------------------------------------------------------------------------------------

const messageSchema = z.object({
  bookingId: z.string().uuid(),
  requestId: z.string().uuid(),
  userId: z.string().uuid(),
  eventId: z.number().int().positive(),
  zoneId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(4),
  requestedAt: z.string(),
});

const PG_UNIQUE_VIOLATION = '23505';

// Returns { bookingId, status, failReason?, duplicate? }. Throws on anything unexpected; the caller must then
// leave the message on the queue so SQS redelivers it (and eventually moves it to the DLQ).
async function processBooking(rawMessage) {
  const msg = messageSchema.parse(rawMessage);
  const { bookingId, requestId, userId, eventId, zoneId, quantity } = msg;
  const log = logger.child({ bookingId, zoneId });

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');

    // Serialise all work for this user. Without it, two workers handling this user's requests for
    // different zones (different FIFO groups, so they can run in parallel) could both pass the per-user
    // limit check. It also makes a concurrent redelivery of this same message wait here, so the
    // idempotency check below sees the other transaction's committed row.
    // Lock order is always users -> bookings -> zones, so workers cannot deadlock each other.
    const user = await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (user.rowCount === 0) throw new Error('user not found');

    // (1) Idempotency: already processed -> nothing to do.
    const existing = await client.query('SELECT status FROM bookings WHERE request_id = $1', [requestId]);
    if (existing.rowCount > 0) {
      await client.query('COMMIT');
      log.info({ status: existing.rows[0].status }, 'booking already processed, skipping duplicate');
      return { bookingId, status: existing.rows[0].status, duplicate: true };
    }

    // (2) Release expired holds in this zone, so their seats are available right now (rule 6).
    await client.query(
      `WITH expired AS (
         UPDATE bookings SET status = 'EXPIRED', updated_at = now()
          WHERE zone_id = $1 AND status = 'PENDING' AND expires_at < now()
         RETURNING quantity
       )
       UPDATE zones
          SET reserved = reserved - COALESCE((SELECT SUM(quantity) FROM expired), 0)
        WHERE id = $1`,
      [zoneId],
    );

    // (3) Per-user limit across the whole event: live PENDING + CONFIRMED.
    const held = await client.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS held
         FROM bookings
        WHERE user_id = $1 AND event_id = $2
          AND (status = 'CONFIRMED' OR (status = 'PENDING' AND expires_at > now()))`,
      [userId, eventId],
    );

    let failReason = null;
    if (held.rows[0].held + quantity > config.maxTicketsPerUser) {
      failReason = 'USER_LIMIT';
    } else {
      // (4) Reserve seats only if they fit. The check and the increment are one atomic statement, and the
      // row lock it takes makes concurrent reservations for this zone wait their turn (rule 5).
      const reserved = await client.query(
        `UPDATE zones SET reserved = reserved + $2
          WHERE id = $1 AND reserved + $2 <= capacity
         RETURNING reserved`,
        [zoneId, quantity],
      );
      if (reserved.rowCount === 0) failReason = 'SOLD_OUT';
    }

    // (5) Record the outcome.
    if (failReason) {
      await client.query(
        `INSERT INTO bookings (id, request_id, user_id, event_id, zone_id, quantity, status, fail_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'FAILED', $7)`,
        [bookingId, requestId, userId, eventId, zoneId, quantity, failReason],
      );
      result = { bookingId, status: 'FAILED', failReason };
    } else {
      await client.query(
        `INSERT INTO bookings (id, request_id, user_id, event_id, zone_id, quantity, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', now() + make_interval(secs => $7 * 60))`,
        [bookingId, requestId, userId, eventId, zoneId, quantity, config.bookingHoldMinutes],
      );
      result = { bookingId, status: 'PENDING' };
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Backstop for the idempotency check: another transaction inserted this request_id first.
    if (err.code === PG_UNIQUE_VIOLATION && err.table === 'bookings') {
      log.info('booking inserted concurrently by another worker, skipping duplicate');
      return { bookingId, status: 'DUPLICATE', duplicate: true };
    }
    throw err;
  } finally {
    client.release();
  }

  // Availability changed (seats reserved and/or expired holds released), so drop the cached zone list.
  await cache.del(cache.keys.eventZones(eventId));
  log.info(result, 'booking processed');
  return result;
}

module.exports = { requestBooking, getBooking, listMyBookings, processBooking };
