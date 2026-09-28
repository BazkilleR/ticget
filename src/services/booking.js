const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const config = require('../config');
const logger = require('../logger');
const { pool } = require('../db');
const { sqs } = require('../sqs');
const { HttpError } = require('../middleware/error');

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

module.exports = { requestBooking, getBooking, listMyBookings };
