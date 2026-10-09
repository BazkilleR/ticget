const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { redis } = require('../src/redis');
const { resetUsers, resetEvents, flushCache, closeConnections, insertEvent, insertZone } = require('./helpers');

const app = createApp();

// startsAt is Bangkok wall-clock time ('2099-03-10 00:30') so day-boundary filters are deterministic.
// Year 2099 keeps every fixture upcoming.
async function insertShow(name, { venue = 'Test Venue', startsAt = '2099-03-10 19:00', saleOpen = true, prices = [] } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO events (name, venue, starts_at, sale_opens_at)
     VALUES ($1, $2, $3::timestamp AT TIME ZONE 'Asia/Bangkok',
             CASE WHEN $4 THEN now() - interval '1 day' ELSE now() + interval '7 days' END)
     RETURNING id`,
    [name, venue, startsAt, saleOpen],
  );
  const eventId = rows[0].id;
  for (const [i, price] of prices.entries()) await insertZone(eventId, `Z${i}`, { price });
  return eventId;
}

const search = (query) => request(app).get('/events').query(query);
const names = (res) => res.body.map((e) => e.name);

beforeEach(async () => {
  await resetUsers();
  await resetEvents();
  await flushCache();
});

afterEach(() => jest.restoreAllMocks());
afterAll(closeConnections);

describe('GET /events?q=', () => {
  beforeEach(async () => {
    await insertShow('Rock Night', { venue: 'Impact Arena', startsAt: '2099-03-01 19:00' });
    await insertShow('Jazz Evening', { venue: 'Thunder Dome', startsAt: '2099-03-02 19:00' });
    await insertShow('คอนเสิร์ตลูกทุ่ง', { venue: 'ราชมังคลา', startsAt: '2099-03-03 19:00' });
  });

  test('matches the event name, ignoring case', async () => {
    const res = await search({ q: 'rOcK' });

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Rock Night']);
  });

  test('matches the venue', async () => {
    expect(names(await search({ q: 'thunder' }))).toEqual(['Jazz Evening']);
  });

  test('matches Thai text in name or venue', async () => {
    expect(names(await search({ q: 'ลูกทุ่ง' }))).toEqual(['คอนเสิร์ตลูกทุ่ง']);
    expect(names(await search({ q: 'ราชมัง' }))).toEqual(['คอนเสิร์ตลูกทุ่ง']);
  });

  test.each(['%', '_', '\\'])('treats %s literally, not as a wildcard', async (ch) => {
    await insertShow(`Sale 50${ch} off`, { startsAt: '2099-03-04 19:00' });

    expect(names(await search({ q: ch }))).toEqual([`Sale 50${ch} off`]);
  });

  test('no match returns an empty list', async () => {
    expect((await search({ q: 'opera' })).body).toEqual([]);
  });

  test('an empty q is the same as no filter', async () => {
    expect(names(await search({ q: '   ' }))).toHaveLength(3);
  });
});

describe('GET /events date and sale filters', () => {
  test('from/to are inclusive Bangkok calendar days', async () => {
    // 00:30 on 10 March in Bangkok is still 9 March in UTC.
    await insertShow('Just after midnight', { startsAt: '2099-03-10 00:30' });
    await insertShow('Late show', { startsAt: '2099-03-10 23:30' });
    await insertShow('Next day', { startsAt: '2099-03-11 00:30' });

    expect(names(await search({ from: '2099-03-10', to: '2099-03-10' }))).toEqual([
      'Just after midnight',
      'Late show',
    ]);
    expect(names(await search({ to: '2099-03-09' }))).toEqual([]);
    expect(names(await search({ from: '2099-03-11' }))).toEqual(['Next day']);
  });

  test('sale=open and sale=upcoming', async () => {
    await insertShow('On sale', { saleOpen: true, startsAt: '2099-03-01 19:00' });
    await insertShow('Coming soon', { saleOpen: false, startsAt: '2099-03-02 19:00' });

    expect(names(await search({ sale: 'open' }))).toEqual(['On sale']);
    expect(names(await search({ sale: 'upcoming' }))).toEqual(['Coming soon']);
  });

  test('never returns events that already started', async () => {
    await insertEvent('Started', '-1 hour');
    await insertShow('Future', { startsAt: '2099-03-01 19:00' });

    expect(names(await search({ q: 'Started' }))).toEqual([]);
    expect(names(await search({ sale: 'open' }))).toEqual(['Future']);
  });
});

describe('GET /events price filter and sort', () => {
  beforeEach(async () => {
    await insertShow('Cheap', { startsAt: '2099-03-03 19:00', prices: [5000, 800] });
    await insertShow('Mid', { startsAt: '2099-03-01 19:00', prices: [2500] });
    await insertShow('Pricey', { startsAt: '2099-03-02 19:00', prices: [9000] });
    await insertShow('No zones', { startsAt: '2099-03-04 19:00' });
  });

  test('maxPrice keeps events with at least one zone at or under the price', async () => {
    expect(names(await search({ maxPrice: '2500' }))).toEqual(['Mid', 'Cheap']);
  });

  test('maxPrice=0 only matches free zones', async () => {
    expect((await search({ maxPrice: '0' })).body).toEqual([]);
  });

  test('sort=price orders by cheapest zone, events without zones last', async () => {
    expect(names(await search({ sort: 'price' }))).toEqual(['Cheap', 'Mid', 'Pricey', 'No zones']);
  });

  test('default order is by date', async () => {
    expect(names(await search({ sort: 'date' }))).toEqual(['Mid', 'Pricey', 'Cheap', 'No zones']);
  });

  test('limit caps the result count', async () => {
    expect(names(await search({ limit: '2' }))).toEqual(['Mid', 'Pricey']);
  });

  test('results include minPrice', async () => {
    const res = await search({ q: 'Cheap' });

    expect(res.body[0]).toMatchObject({ name: 'Cheap', minPrice: 800 });
  });
});

describe('GET /events validation and caching', () => {
  test.each([
    [{ from: '2099-13-01' }],
    [{ from: 'tomorrow' }],
    [{ from: '2099-03-10', to: '2099-03-09' }],
    [{ sale: 'soon' }],
    [{ maxPrice: '-1' }],
    [{ maxPrice: '' }],
    [{ maxPrice: '1e3' }],
    [{ sort: 'name' }],
    [{ limit: '0' }],
    [{ limit: '51' }],
    [{ q: 'x'.repeat(101) }],
  ])('%o returns 400 validation_error', async (query) => {
    const res = await search(query);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  test('filtered searches are not cached', async () => {
    await insertShow('Rock Night');

    await search({ q: 'rock' }).expect(200);

    expect(await redis.keys('*')).toEqual([]);
  });

  test('unknown parameters fall back to the cached plain list', async () => {
    await insertShow('Rock Night');

    await search({ foo: 'bar' }).expect(200);

    expect(await redis.exists('events:list')).toBe(1);
  });
});

describe('GET /events/:id', () => {
  test('returns the event with description and minPrice', async () => {
    const eventId = await insertShow('Rock Night', { venue: 'Impact Arena', prices: [3000, 1200] });
    await pool.query(`UPDATE events SET description = 'ประตูเปิด 17:00 น.' WHERE id = $1`, [eventId]);

    const res = await request(app).get(`/events/${eventId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: eventId,
      name: 'Rock Night',
      venue: 'Impact Arena',
      description: 'ประตูเปิด 17:00 น.',
      startsAt: expect.any(String),
      saleOpensAt: expect.any(String),
      minPrice: 1200,
    });
  });

  test('still returns an event that already started', async () => {
    const eventId = await insertEvent('Started', '-1 hour');

    expect((await request(app).get(`/events/${eventId}`)).status).toBe(200);
  });

  test('is cached in event:{id} for 60 seconds', async () => {
    const eventId = await insertShow('Rock Night');

    await request(app).get(`/events/${eventId}`).expect(200);

    const ttl = await redis.ttl(`event:${eventId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test('unknown event returns 404 event_not_found and is not cached', async () => {
    const res = await request(app).get('/events/999');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('event_not_found');
    expect(await redis.exists('event:999')).toBe(0);
  });

  test.each(['abc', '0', '99999999999'])('id %s returns 400', async (id) => {
    expect((await request(app).get(`/events/${id}`)).status).toBe(400);
  });
});

describe('events schedule constraint', () => {
  test('a sale cannot open after the event starts', async () => {
    await expect(
      pool.query(
        `INSERT INTO events (name, venue, starts_at, sale_opens_at)
         VALUES ('Bad', 'X', now() + interval '1 day', now() + interval '2 days')`,
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'events_schedule_chk' });
  });
});
