const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../middleware/error');
const adminTickets = require('../../services/adminTickets');

const router = express.Router();

// Ticket codes are 32 lowercase hex characters; accept them typed in upper case or with spaces around.
const code = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{32}$/, 'must be a 32-character ticket code');

const checkInSchema = z.object({
  code,
  eventId: z.number().int().positive().max(2147483647),
});

router.get('/tickets/:code', validate({ params: z.object({ code }) }), asyncHandler(async (req, res) => {
  res.json(await adminTickets.getTicket(req.params.code));
}));

router.post('/tickets/check-in', validate({ body: checkInSchema }), asyncHandler(async (req, res) => {
  const ticket = await adminTickets.checkIn(req.userId, req.body);
  req.log.info({ adminId: req.userId, bookingId: ticket.bookingId, eventId: ticket.eventId, seq: ticket.seq }, 'ticket_checked_in');
  res.json(ticket);
}));

module.exports = router;
