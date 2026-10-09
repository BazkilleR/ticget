// Admin event and zone management (Phase 12).
const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { redis } = require('../src/redis');
const { processBooking } = require('../src/services/booking');
const {
  resetUsers,
  resetEvents,
  flushCache,
  closeConnections,
  insertEvent,
  insertZone,
  insertBooking,
  createUser,
} = require('./helpers');

const app = createApp();

let admin;
let user;

const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

const newEvent = (overrides = {}) => ({
  name: 'Rock Night',
  venue: 'Impact Arena',
  description: 'ประตูเปิด 17:00 น.',
  startsAt: inDays(30),
  saleOpensAt: inDays(-1),
  zones: [
    { name: 'VIP', price: 5000, capacity: 50 },
    { name: 'GA', price: 1500, capacity: 500 },
  ],
  ...overrides,
});

const as = (who) => ({ Authorization: `Bearer ${who.token}` });
const api = {
  get: (path, who = admin) => request(app).get(path).set(as(who)),
  post: (path, body, who = admin) => request(app).post(path).set(as(who)).send(body),
  patch: (path, body, who = admin) => request(app).patch(path).set(as(who)).send(body),
  delete: (path, who = admin) => request(app).delete(path).set(as(who)),
};

async function zoneRow(zoneId) {
  const { rows } = await pool.query('SELECT * FROM zones WHERE id = $1', [zoneId]);
  return rows[0];
}

beforeEach(async () => {
  await resetUsers();
  await resetEvents();
  await flushCache();
  admin = await createUser('boss', { role: 'admin' });
  user = await createUser('alice');
});

afterAll(closeConnections);

describe('access', () => {
  test.each([
    ['get', '/admin/events'],
    ['post', '/admin/events'],
    ['get', '/admin/events/1'],
    ['patch', '/admin/events/1'],
    ['delete', '/admin/events/1'],
    ['post', '/admin/events/1/zones'],
    ['patch', '/admin/zones/1'],
    ['delete', '/admin/zones/1'],
  ])('%s %s: 401 without a token, 403 for a normal user', async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);

    const res = await request(app)[method](path).set(as(user)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});

describe('POST /admin/events', () => {
  test('creates the event with its zones', async () => {
    const res = await api.post('/admin/events', newEvent());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(Number),
      name: 'Rock Night',
      venue: 'Impact Arena',
      description: 'ประตูเปิด 17:00 น.',
    });
    expect(res.body.zones).toEqual([
      expect.objectContaining({ name: 'VIP', price: 5000, capacity: 50, reserved: 0, available: 50, sold: 0 }),
      expect.objectContaining({ name: 'GA', price: 1500, capacity: 500, reserved: 0, available: 500 }),
    ]);
  });

  test('is visible on the public list straight away, even when it was cached', async () => {
    await insertEvent('Existing', '10 days');
    await request(app).get('/events').expect(200); // fills events:list

    const created = await api.post('/admin/events', newEvent()).expect(201);

    const list = await request(app).get('/events');
    expect(list.body.map((e) => e.id)).toContain(created.body.id);
    expect(list.body.find((e) => e.id === created.body.id).minPrice).toBe(1500);
  });

  test('a normal user can book it right away', async () => {
    const created = await api.post('/admin/events', newEvent()).expect(201);
    const zoneId = created.body.zones[1].zoneId;

    const res = await request(app)
      .post('/bookings')
      .set(as(user))
      .send({ eventId: created.body.id, zoneId, quantity: 2, requestId: randomUUID() });

    expect(res.status).toBe(202);
  });

  test('accepts the Thai-time format the admin form sends (+07:00)', async () => {
    const res = await api.post('/admin/events', newEvent({ startsAt: '2099-11-08T19:00:00+07:00', saleOpensAt: '2099-10-01T10:00:00+07:00' }));

    expect(res.status).toBe(201);
    expect(new Date(res.body.startsAt).toISOString()).toBe('2099-11-08T12:00:00.000Z');
  });

  test('description is optional', async () => {
    const { description, ...rest } = newEvent();

    const res = await api.post('/admin/events', rest);

    expect(res.status).toBe(201);
    expect(res.body.description).toBeNull();
  });

  test.each([
    ['no zones', { zones: [] }],
    ['11 zones', { zones: Array.from({ length: 11 }, (_, i) => ({ name: `Z${i}`, price: 100, capacity: 10 })) }],
    ['duplicate zone names', { zones: [{ name: 'GA', price: 1, capacity: 1 }, { name: 'GA', price: 2, capacity: 2 }] }],
    ['sale opening after the show', { saleOpensAt: inDays(31) }],
    ['a show in the past', { startsAt: inDays(-1), saleOpensAt: inDays(-2) }],
    ['a date without an offset', { startsAt: '2099-01-01T19:00:00' }],
    ['a blank name', { name: '   ' }],
    ['a negative price', { zones: [{ name: 'GA', price: -1, capacity: 10 }] }],
    ['a zero capacity', { zones: [{ name: 'GA', price: 100, capacity: 0 }] }],
    ['a fractional price', { zones: [{ name: 'GA', price: 99.5, capacity: 10 }] }],
  ])('rejects %s with 400', async (_name, overrides) => {
    const res = await api.post('/admin/events', newEvent(overrides));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });
});

describe('GET /admin/events', () => {
  test('lists upcoming events with seat totals; include=past adds started ones', async () => {
    const eventId = await insertEvent('Upcoming', '30 days');
    const zoneId = await insertZone(eventId, 'GA', { capacity: 100, reserved: 7 });
    await insertBooking({ userId: user.userId, eventId, zoneId, quantity: 3, status: 'CONFIRMED' });
    await insertBooking({ userId: user.userId, eventId, zoneId, quantity: 4, status: 'PENDING' });
    await insertBooking({ userId: user.userId, eventId, zoneId, quantity: 2, status: 'PENDING', expiresIn: '-1 minute' });
    await insertEvent('Started', '-1 hour');

    const res = await api.get('/admin/events');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: eventId, zoneCount: 1, capacity: 100, sold: 3, held: 4, bookingCount: 3 }),
    ]);

    const all = await api.get('/admin/events?include=past');
    expect(all.body.map((e) => e.name)).toEqual(['Started', 'Upcoming']);
  });

  test('an event with no zones reports zeros', async () => {
    await insertEvent('Empty', '30 days');

    const res = await api.get('/admin/events');

    expect(res.body[0]).toMatchObject({ zoneCount: 0, capacity: 0, sold: 0, held: 0, bookingCount: 0 });
  });
});

describe('GET /admin/events/:id', () => {
  test('returns zones with reserved, available, sold and held', async () => {
    const eventId = await insertEvent('Concert', '30 days');
    // reserved 6 = 1 sold + 2 held + 3 in an expired hold nobody has released yet.
    const zoneId = await insertZone(eventId, 'GA', { capacity: 10, reserved: 6 });
    await insertBooking({ userId: user.userId, eventId, zoneId, quantity: 1, status: 'CONFIRMED' });
    await insertBooking({ userId: user.userId, eventId, zoneId, quantity: 2 });
    await insertBooking({ userId: user.userId, eventId, zoneId, quantity: 3, expiresIn: '-1 minute' });

    const res = await api.get(`/admin/events/${eventId}`);

    expect(res.status).toBe(200);
    expect(res.body.zones).toEqual([
      {
        zoneId,
        name: 'GA',
        price: 1000,
        capacity: 10,
        reserved: 6,
        available: 7,
        sold: 1,
        held: 2,
        bookingCount: 3,
      },
    ]);
  });

  test('unknown event returns 404', async () => {
    const res = await api.get('/admin/events/999');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('event_not_found');
  });
});

describe('PATCH /admin/events/:id', () => {
  let eventId;

  beforeEach(async () => {
    eventId = (await api.post('/admin/events', newEvent()).expect(201)).body.id;
  });

  test('updates only the given fields and refreshes the public caches', async () => {
    await request(app).get(`/events/${eventId}`).expect(200); // fills event:{id}

    const res = await api.patch(`/admin/events/${eventId}`, { name: 'Rock Night (Extra Show)' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Rock Night (Extra Show)', venue: 'Impact Arena' });
    expect((await request(app).get(`/events/${eventId}`)).body.name).toBe('Rock Night (Extra Show)');
  });

  test('an empty description clears it', async () => {
    const res = await api.patch(`/admin/events/${eventId}`, { description: '' });

    expect(res.body.description).toBeNull();
  });

  test('moving the show before the sale opens is rejected by the database check', async () => {
    const res = await api.patch(`/admin/events/${eventId}`, { startsAt: inDays(-2) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_schedule');
  });

  test('an empty body is a 400', async () => {
    expect((await api.patch(`/admin/events/${eventId}`, {})).status).toBe(400);
  });

  test('unknown event returns 404', async () => {
    expect((await api.patch('/admin/events/999', { name: 'X' })).status).toBe(404);
  });
});

describe('DELETE /admin/events/:id', () => {
  test('deletes an event nobody has booked, with its zones', async () => {
    const event = (await api.post('/admin/events', newEvent()).expect(201)).body;

    expect((await api.delete(`/admin/events/${event.id}`)).status).toBe(204);

    expect((await api.get(`/admin/events/${event.id}`)).status).toBe(404);
    expect(await zoneRow(event.zones[0].zoneId)).toBeUndefined();
  });

  test('refuses an event with any booking, even a failed one', async () => {
    const eventId = await insertEvent('Concert', '30 days');
    const zoneId = await insertZone(eventId, 'GA');
    await insertBooking({ userId: user.userId, eventId, zoneId, status: 'FAILED', failReason: 'SOLD_OUT' });

    const res = await api.delete(`/admin/events/${eventId}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('event_has_bookings');
    expect(await zoneRow(zoneId)).toBeDefined();
  });

  test('unknown event returns 404', async () => {
    expect((await api.delete('/admin/events/999')).status).toBe(404);
  });
});

describe('zones', () => {
  let eventId;
  let zoneId;

  beforeEach(async () => {
    eventId = await insertEvent('Concert', '30 days');
    zoneId = await insertZone(eventId, 'GA', { price: 1500, capacity: 10 });
  });

  test('POST adds a zone that shows up on the public zone list', async () => {
    await request(app).get(`/events/${eventId}/zones`).expect(200); // fills the cache

    const res = await api.post(`/admin/events/${eventId}/zones`, { name: 'VIP', price: 5000, capacity: 20 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ eventId, name: 'VIP', capacity: 20, available: 20 });
    const zones = await request(app).get(`/events/${eventId}/zones`);
    expect(zones.body.map((z) => z.name)).toEqual(['GA', 'VIP']);
  });

  test('POST to an unknown event returns 404', async () => {
    const res = await api.post('/admin/events/999/zones', { name: 'VIP', price: 5000, capacity: 20 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('event_not_found');
  });

  test('PATCH changes the price on the public zone list', async () => {
    await request(app).get(`/events/${eventId}/zones`).expect(200);

    const res = await api.patch(`/admin/zones/${zoneId}`, { price: 1800 });

    expect(res.status).toBe(200);
    expect((await request(app).get(`/events/${eventId}/zones`)).body[0].price).toBe(1800);
    expect((await request(app).get('/events')).body[0].minPrice).toBe(1800);
  });

  test('PATCH renaming to an existing zone name returns 409', async () => {
    await insertZone(eventId, 'VIP');

    const res = await api.patch(`/admin/zones/${zoneId}`, { name: 'VIP' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('zone_name_taken');
  });

  test('PATCH can raise capacity and lower it down to what is reserved', async () => {
    await pool.query('UPDATE zones SET reserved = 6 WHERE id = $1', [zoneId]);

    expect((await api.patch(`/admin/zones/${zoneId}`, { capacity: 50 })).body.capacity).toBe(50);
    expect((await api.patch(`/admin/zones/${zoneId}`, { capacity: 6 })).body).toMatchObject({ capacity: 6, available: 0 });
  });

  test('PATCH below the reserved seats returns 409 and leaves the zone alone', async () => {
    await insertBooking({ userId: user.userId, eventId, zoneId, quantity: 4 });
    await pool.query('UPDATE zones SET reserved = 4 WHERE id = $1', [zoneId]);

    const res = await api.patch(`/admin/zones/${zoneId}`, { capacity: 3, price: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('capacity_below_reserved');
    expect(res.body.message).toMatch(/4/);
    expect(await zoneRow(zoneId)).toMatchObject({ capacity: 10, price: 1500, reserved: 4 });
  });

  test('PATCH releases expired holds first, so they do not block lowering capacity', async () => {
    const expired = await insertBooking({ userId: user.userId, eventId, zoneId, quantity: 4, expiresIn: '-1 minute' });
    await insertBooking({ userId: user.userId, eventId, zoneId, quantity: 1 });
    await pool.query('UPDATE zones SET reserved = 5 WHERE id = $1', [zoneId]);

    const res = await api.patch(`/admin/zones/${zoneId}`, { capacity: 1 });

    expect(res.status).toBe(200);
    expect(await zoneRow(zoneId)).toMatchObject({ capacity: 1, reserved: 1 });
    const { rows } = await pool.query('SELECT status FROM bookings WHERE id = $1', [expired]);
    expect(rows[0].status).toBe('EXPIRED');
  });

  test('PATCH with an empty body or unknown zone', async () => {
    expect((await api.patch(`/admin/zones/${zoneId}`, {})).status).toBe(400);
    expect((await api.patch('/admin/zones/999', { price: 1 })).status).toBe(404);
  });

  test('DELETE removes an unbooked zone and refuses a booked one', async () => {
    const booked = await insertZone(eventId, 'VIP');
    await insertBooking({ userId: user.userId, eventId, zoneId: booked, status: 'FAILED', failReason: 'SOLD_OUT' });

    expect((await api.delete(`/admin/zones/${zoneId}`)).status).toBe(204);
    expect(await zoneRow(zoneId)).toBeUndefined();

    const res = await api.delete(`/admin/zones/${booked}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('zone_has_bookings');
    expect((await api.delete('/admin/zones/999')).status).toBe(404);
  });
});

describe('lowering capacity while people are booking', () => {
  test('never ends up with more seats reserved than the zone holds', async () => {
    const eventId = await insertEvent('Rush', '30 days');
    const zoneId = await insertZone(eventId, 'GA', { capacity: 20 });
    const buyers = await Promise.all(Array.from({ length: 20 }, (_, i) => createUser(`buyer${i}`)));

    const bookings = buyers.map(({ userId }) => {
      const requestId = randomUUID();
      return processBooking({
        bookingId: requestId,
        requestId,
        userId,
        eventId,
        zoneId,
        quantity: 1,
        requestedAt: new Date().toISOString(),
      });
    });
    // Shrink the zone in the middle of the rush. It may win or lose against the bookings already in;
    // either way the database must stay consistent.
    const shrink = api.patch(`/admin/zones/${zoneId}`, { capacity: 8 });

    const [shrinkRes] = await Promise.all([shrink, ...bookings]);

    const zone = await zoneRow(zoneId);
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS held FROM bookings WHERE zone_id = $1 AND status = 'PENDING'`,
      [zoneId],
    );
    expect(zone.reserved).toBeLessThanOrEqual(zone.capacity);
    expect(rows[0].held).toBe(zone.reserved);
    if (shrinkRes.status === 200) {
      expect(zone.capacity).toBe(8);
      expect(zone.reserved).toBeLessThanOrEqual(8);
    } else {
      expect(shrinkRes.body.error).toBe('capacity_below_reserved');
      expect(zone.capacity).toBe(20);
    }
  });
});

describe('cache', () => {
  test('deleting an event clears its cached public pages', async () => {
    const event = (await api.post('/admin/events', newEvent()).expect(201)).body;
    await request(app).get(`/events/${event.id}`).expect(200);
    await request(app).get(`/events/${event.id}/zones`).expect(200);

    await api.delete(`/admin/events/${event.id}`).expect(204);

    expect(await redis.exists(`event:${event.id}`, `event:${event.id}:zones`)).toBe(0);
    expect((await request(app).get(`/events/${event.id}`)).status).toBe(404);
  });
});
