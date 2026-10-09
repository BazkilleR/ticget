const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { redis } = require('../src/redis');
const {
  resetUsers,
  resetEvents,
  flushCache,
  closeConnections,
  insertEvent,
  insertZone,
} = require('./helpers');

const app = createApp();

beforeEach(async () => {
  await resetUsers();
  await resetEvents();
  await flushCache();
});

afterEach(() => jest.restoreAllMocks());
afterAll(closeConnections);

describe('GET /events', () => {
  test('lists only events that have not started, soonest first', async () => {
    const later = await insertEvent('Later', '60 days');
    const sooner = await insertEvent('Sooner', '30 days');
    await insertEvent('Already started', '-1 hour');

    const res = await request(app).get('/events');

    expect(res.status).toBe(200);
    expect(res.body.map((e) => e.id)).toEqual([sooner, later]);
    expect(res.body[0]).toEqual({
      id: sooner,
      name: 'Sooner',
      venue: 'Test Venue',
      startsAt: expect.any(String),
      saleOpensAt: expect.any(String),
      minPrice: null,
    });
  });

  test('minPrice is the cheapest zone', async () => {
    const eventId = await insertEvent('Concert', '30 days');
    await insertZone(eventId, 'VIP', { price: 5000 });
    await insertZone(eventId, 'GA', { price: 1500 });

    const res = await request(app).get('/events');

    expect(res.body[0].minPrice).toBe(1500);
  });

  test('is cached in events:list for 60 seconds', async () => {
    await insertEvent('First', '30 days');
    await request(app).get('/events').expect(200);

    const ttl = await redis.ttl('events:list');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    // A new row is not visible until the cache expires or is cleared.
    await insertEvent('Second', '31 days');
    const cached = await request(app).get('/events');
    expect(cached.body.map((e) => e.name)).toEqual(['First']);

    await flushCache();
    const fresh = await request(app).get('/events');
    expect(fresh.body.map((e) => e.name)).toEqual(['First', 'Second']);
  });
});

describe('GET /events/:id/zones', () => {
  test('returns zones with available = capacity - reserved', async () => {
    const eventId = await insertEvent('Concert', '30 days');
    const vip = await insertZone(eventId, 'VIP', { price: 5000, capacity: 5, reserved: 5 });
    const std = await insertZone(eventId, 'Standard', { price: 2500, capacity: 100, reserved: 37 });
    const ga = await insertZone(eventId, 'GA', { price: 1500, capacity: 500 });

    const res = await request(app).get(`/events/${eventId}/zones`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { zoneId: vip, name: 'VIP', price: 5000, available: 0 },
      { zoneId: std, name: 'Standard', price: 2500, available: 63 },
      { zoneId: ga, name: 'GA', price: 1500, available: 500 },
    ]);
  });

  test('expired PENDING bookings do not count as taken', async () => {
    const eventId = await insertEvent('Concert', '30 days');
    // reserved = 4: 3 from an expired hold (not yet cleaned up) + 1 still-valid hold.
    const zoneId = await insertZone(eventId, 'GA', { capacity: 10, reserved: 4 });
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash) VALUES ('buyer', 'x') RETURNING id`,
    );
    const userId = rows[0].id;
    await pool.query(
      `INSERT INTO bookings (id, request_id, user_id, event_id, zone_id, quantity, status, expires_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), $1, $2, $3, 3, 'PENDING', now() - interval '1 minute'),
              (gen_random_uuid(), gen_random_uuid(), $1, $2, $3, 1, 'PENDING', now() + interval '5 minutes')`,
      [userId, eventId, zoneId],
    );

    const res = await request(app).get(`/events/${eventId}/zones`);

    expect(res.status).toBe(200);
    expect(res.body[0].available).toBe(9);
  });

  test('is cached in event:{id}:zones for 3 seconds', async () => {
    const eventId = await insertEvent('Concert', '30 days');
    await insertZone(eventId, 'GA');

    await request(app).get(`/events/${eventId}/zones`).expect(200);

    const ttl = await redis.ttl(`event:${eventId}:zones`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3);
  });

  test('event with no zones returns an empty list', async () => {
    const eventId = await insertEvent('Empty', '30 days');

    const res = await request(app).get(`/events/${eventId}/zones`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('unknown event returns 404 event_not_found and is not cached', async () => {
    const res = await request(app).get('/events/999/zones');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('event_not_found');
    expect(await redis.exists('event:999:zones')).toBe(0);
  });

  test.each(['abc', '0', '-1', '1.5', '99999999999'])('id %s returns 400 validation_error', async (id) => {
    const res = await request(app).get(`/events/${id}/zones`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });
});

describe('when Redis is unavailable', () => {
  beforeEach(() => {
    const down = new Error('Connection is closed.');
    jest.spyOn(redis, 'get').mockRejectedValue(down);
    jest.spyOn(redis, 'set').mockRejectedValue(down);
  });

  test('GET /events falls back to the database', async () => {
    await insertEvent('Concert', '30 days');

    const res = await request(app).get('/events');

    expect(res.status).toBe(200);
    expect(res.body.map((e) => e.name)).toEqual(['Concert']);
  });

  test('GET /events/:id/zones falls back to the database', async () => {
    const eventId = await insertEvent('Concert', '30 days');
    await insertZone(eventId, 'GA', { capacity: 10, reserved: 2 });

    const res = await request(app).get(`/events/${eventId}/zones`);

    expect(res.status).toBe(200);
    expect(res.body[0].available).toBe(8);
  });
});
