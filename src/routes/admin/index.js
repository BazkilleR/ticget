const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const { requireAdmin } = require('../../middleware/admin');
const eventsRouter = require('./events');
const ticketsRouter = require('./tickets');
const salesRouter = require('./sales');

// Everything under /admin requires an admin. Applied once here so no admin route can forget it.
const router = express.Router();

router.use(requireAuth, requireAdmin);
router.use(eventsRouter);
router.use(ticketsRouter);
router.use(salesRouter);

module.exports = router;
