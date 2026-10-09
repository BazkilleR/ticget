const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../middleware/error');
const adminSales = require('../../services/adminSales');

const router = express.Router();

const INT4_MAX = 2147483647;
const idParams = z.object({ id: z.coerce.number().int().positive().max(INT4_MAX) });

const reportQuery = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    eventId: z
      .string()
      .regex(/^\d+$/, 'must be a whole number')
      .transform(Number)
      .refine((n) => n >= 1 && n <= INT4_MAX, 'out of range')
      .optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'must not be after to', path: ['from'] });

router.get('/dashboard', asyncHandler(async (req, res) => {
  res.json(await adminSales.dashboard());
}));

router.get('/events/:id/sales', validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.json(await adminSales.eventSales(req.params.id));
}));

router.get('/reports/sales.csv', validate({ query: reportQuery }), asyncHandler(async (req, res) => {
  const csv = await adminSales.salesCsv(req.query);
  const day = new Date().toISOString().slice(0, 10);
  res
    .type('text/csv; charset=utf-8')
    .attachment(`sales-${day}.csv`)
    .set('Cache-Control', 'no-store')
    .send(csv);
}));

module.exports = router;
