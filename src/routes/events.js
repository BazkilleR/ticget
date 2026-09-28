const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/error');
const eventsService = require('../services/events');

const router = express.Router();

// events.id is SERIAL (int4); cap it so huge ids are a 400, not a Postgres out-of-range 500.
const idParams = z.object({
  id: z.coerce.number().int().positive().max(2147483647),
});

router.get('/', asyncHandler(async (req, res) => {
  res.json(await eventsService.listUpcoming());
}));

router.get('/:id/zones', validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.json(await eventsService.listZones(req.params.id));
}));

module.exports = router;
