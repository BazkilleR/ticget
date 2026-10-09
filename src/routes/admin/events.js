const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../middleware/error');
const adminEvents = require('../../services/adminEvents');

const router = express.Router();

const INT4_MAX = 2147483647;
const idParams = z.object({ id: z.coerce.number().int().positive().max(INT4_MAX) });

const text = (max) => z.string().trim().min(1).max(max);
// An empty description clears it.
const description = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .transform((d) => d || null);
// Must carry an offset (Z or +07:00) so "19:00" can never be read in the server's time zone.
const timestamp = z.string().datetime({ offset: true });

const zoneFields = {
  name: text(50),
  price: z.number().int().min(0).max(1_000_000),
  capacity: z.number().int().min(1).max(100_000),
};

const scheduleOk = (e) => !e.startsAt || !e.saleOpensAt || new Date(e.saleOpensAt) <= new Date(e.startsAt);
const schedule = { message: 'must not be after startsAt', path: ['saleOpensAt'] };
const notEmpty = [(patch) => Object.values(patch).some((v) => v !== undefined), 'nothing to update'];

const createSchema = z
  .object({
    name: text(200),
    venue: text(200),
    description: description.optional(),
    startsAt: timestamp.refine((t) => new Date(t) > new Date(), 'must be in the future'),
    saleOpensAt: timestamp,
    zones: z
      .array(z.object(zoneFields))
      .min(1)
      .max(10)
      .refine((zones) => new Set(zones.map((zone) => zone.name)).size === zones.length, 'zone names must be unique'),
  })
  .refine(scheduleOk, schedule);

// A PATCH with only one of the two dates is checked against the stored one by events_schedule_chk.
const updateEventSchema = z
  .object({
    name: text(200).optional(),
    venue: text(200).optional(),
    description: description.optional(),
    startsAt: timestamp.optional(),
    saleOpensAt: timestamp.optional(),
  })
  .refine(...notEmpty)
  .refine(scheduleOk, schedule);

const zoneSchema = z.object(zoneFields);
const updateZoneSchema = z
  .object({
    name: zoneFields.name.optional(),
    price: zoneFields.price.optional(),
    capacity: zoneFields.capacity.optional(),
  })
  .refine(...notEmpty);

const listQuery = z.object({ include: z.enum(['past']).optional() });

// Every change is logged with the admin's id as a simple audit trail.
function audit(req, action, details) {
  req.log.info({ adminId: req.userId, action, ...details }, 'admin_event_change');
}

router.get('/events', validate({ query: listQuery }), asyncHandler(async (req, res) => {
  res.json(await adminEvents.listEvents({ includePast: req.query.include === 'past' }));
}));

router.post('/events', validate({ body: createSchema }), asyncHandler(async (req, res) => {
  const event = await adminEvents.createEvent(req.body);
  audit(req, 'create_event', { eventId: event.id });
  res.status(201).json(event);
}));

router.get('/events/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  res.json(await adminEvents.getEvent(req.params.id));
}));

router.patch('/events/:id', validate({ params: idParams, body: updateEventSchema }), asyncHandler(async (req, res) => {
  const event = await adminEvents.updateEvent(req.params.id, req.body);
  audit(req, 'update_event', { eventId: event.id, fields: Object.keys(req.body) });
  res.json(event);
}));

router.delete('/events/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  await adminEvents.deleteEvent(req.params.id);
  audit(req, 'delete_event', { eventId: req.params.id });
  res.status(204).end();
}));

router.post('/events/:id/zones', validate({ params: idParams, body: zoneSchema }), asyncHandler(async (req, res) => {
  const zone = await adminEvents.addZone(req.params.id, req.body);
  audit(req, 'add_zone', { eventId: req.params.id, zoneId: zone.zoneId });
  res.status(201).json(zone);
}));

router.patch('/zones/:id', validate({ params: idParams, body: updateZoneSchema }), asyncHandler(async (req, res) => {
  const zone = await adminEvents.updateZone(req.params.id, req.body);
  audit(req, 'update_zone', { eventId: zone.eventId, zoneId: zone.zoneId, fields: Object.keys(req.body) });
  res.json(zone);
}));

router.delete('/zones/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  await adminEvents.deleteZone(req.params.id);
  audit(req, 'delete_zone', { zoneId: req.params.id });
  res.status(204).end();
}));

module.exports = router;
