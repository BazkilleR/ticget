const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/error');
const eventsService = require('../services/events');

const router = express.Router();

const INT4_MAX = 2147483647;

// events.id is SERIAL (int4); cap it so huge ids are a 400, not a Postgres out-of-range 500.
const idParams = z.object({
  id: z.coerce.number().int().positive().max(INT4_MAX),
});

// Digits only: z.coerce.number() would quietly turn "" into 0 and "1e3" into 1000.
const wholeNumber = (max) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .refine((n) => n <= max, `must be at most ${max}`);

// Every filter is optional; with none at all the cached plain list is served. An empty q (a cleared
// search box) counts as no q. Unknown parameters are dropped.
const searchQuery = z
  .object({
    q: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((q) => q || undefined),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    sale: z.enum(['open', 'upcoming']).optional(),
    maxPrice: wholeNumber(INT4_MAX).optional(),
    sort: z.enum(['date', 'price']).optional(),
    limit: wholeNumber(50)
      .refine((n) => n >= 1, 'must be at least 1')
      .optional(),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: 'must not be after to', path: ['from'] });

router.get('/', validate({ query: searchQuery }), asyncHandler(async (req, res) => {
  const filtered = Object.values(req.query).some((v) => v !== undefined);
  res.json(filtered ? await eventsService.search(req.query) : await eventsService.listUpcoming());
}));

router.get('/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.json(await eventsService.getEvent(req.params.id));
}));

router.get('/:id/zones', validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.json(await eventsService.listZones(req.params.id));
}));

module.exports = router;
