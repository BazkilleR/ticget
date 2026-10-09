// Door check-in for admins. Only reachable through routes/admin (requireAuth + requireAdmin).
const { pool } = require('../db');
const { HttpError } = require('../middleware/error');

const TICKET_SELECT = `
  SELECT t.code, t.seq, b.quantity, t.checked_in_at AS "checkedInAt",
         b.id AS "bookingId", u.username,
         e.id AS "eventId", e.name AS "eventName", e.starts_at AS "startsAt",
         z.name AS "zoneName"
    FROM tickets t
    JOIN bookings b ON b.id = t.booking_id
    JOIN users u    ON u.id = b.user_id
    JOIN events e   ON e.id = b.event_id
    JOIN zones z    ON z.id = b.zone_id`;

async function getTicket(code) {
  const { rows } = await pool.query(`${TICKET_SELECT} WHERE t.code = $1`, [code]);
  if (!rows[0]) throw new HttpError(404, 'ticket_not_found', 'Ticket not found');
  return rows[0];
}

// The conditional UPDATE is the whole rule: right event, paid, and not used yet. Two gates scanning the
// same ticket at once both run it, but only the first matches checked_in_at IS NULL.
async function checkIn(adminId, { code, eventId }) {
  const { rowCount } = await pool.query(
    `UPDATE tickets t SET checked_in_at = now(), checked_in_by = $3
       FROM bookings b
      WHERE b.id = t.booking_id
        AND t.code = $1 AND b.event_id = $2 AND b.status = 'CONFIRMED'
        AND t.checked_in_at IS NULL`,
    [code, eventId, adminId],
  );
  const ticket = await getTicket(code);
  if (rowCount === 1) return ticket;

  // Nothing changed: say why, using what getTicket found.
  if (ticket.eventId !== eventId) {
    throw new HttpError(409, 'ticket_wrong_event', `This ticket is for ${ticket.eventName}`);
  }
  throw new HttpError(409, 'ticket_already_used', `Already checked in at ${ticket.checkedInAt.toISOString()}`);
}

module.exports = { getTicket, checkIn };
