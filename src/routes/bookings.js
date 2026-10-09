const express = require('express');
const { z } = require('zod');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/error');
const bookingService = require('../services/booking');

const router = express.Router();

const INT4_MAX = 2147483647;
const id = z.number().int().positive().max(INT4_MAX);

// No userId here on purpose: it always comes from the JWT (rule 1). zod strips unknown keys, so a
// userId sent in the body is silently dropped.
const createSchema = z.object({
  eventId: id,
  zoneId: id,
  quantity: z.number().int().min(1).max(4),
  requestId: z.string().uuid(),
});

const bookingParams = z.object({ id: z.string().uuid() });

router.post('/bookings', requireAuth, validate({ body: createSchema }), asyncHandler(async (req, res) => {
  res.status(202).json(await bookingService.requestBooking(req.userId, req.body));
}));

router.get('/bookings/:id', requireAuth, validate({ params: bookingParams }), asyncHandler(async (req, res) => {
  res.json(await bookingService.getBooking(req.userId, req.params.id));
}));

router.post('/bookings/:id/pay', requireAuth, validate({ params: bookingParams }), asyncHandler(async (req, res) => {
  res.json(await bookingService.payBooking(req.userId, req.params.id));
}));

router.get('/bookings/:id/tickets', requireAuth, validate({ params: bookingParams }), asyncHandler(async (req, res) => {
  res.json(await bookingService.getTickets(req.userId, req.params.id));
}));

module.exports = router;
