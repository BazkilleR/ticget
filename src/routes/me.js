const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');
const authService = require('../services/auth');
const bookingService = require('../services/booking');

const router = express.Router();

router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => {
  res.json(await authService.getUser(req.userId));
}));

router.get('/bookings', asyncHandler(async (req, res) => {
  res.json(await bookingService.listMyBookings(req.userId));
}));

module.exports = router;
