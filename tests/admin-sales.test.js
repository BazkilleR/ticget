// Sales dashboard, per-event sales and the CSV report (Phase 14).
const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { processBooking } = require('../src/services/booking');
const { csvField } = require('../src/services/adminSales');
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
let alice;
let bob;
let carol;
let eventA;
let eventB;
let vip;
let ga;
let zoneB;

const get = (path, who = admin) => request(app).get(path).set('Authorization', `Bearer ${who.token}`);

async function bangkokDate(daysAgo = 0) {
  const { rows } = await pool.query(
    `SELECT to_char((now() AT TIME ZONE 'Asia/Bangkok')::date - $1::int, 'YYYY-MM-DD') AS d`,
    [daysAgo],
  );
  return rows[0].d;
}

// A mix of every booking state. Expected totals:
//   sold 6 tickets, revenue 2x5000 + 3x1000 + 1x2000 = 15000; held 4 (the expired hold does not count).
beforeEach(async () => {
  await resetUsers();
  await resetEvents();
  await flushCache();
  admin = await createUser('boss', { role: 'admin' });
  alice = await createUser('alice');
  bob = await createUser('bob');
  carol = await createUser('carol');
  eventA = await insertEvent('Concert A', '30 days');
  eventB = await insertEvent('Concert B', '40 days');
  vip = await insertZone(eventA, 'VIP', { price: 5000, capacity: 10, reserved: 2 });
  ga = await insertZone(eventA, 'GA', { price: 1000, capacity: 100, reserved: 9 });
  zoneB = await insertZone(eventB, 'Floor', { price: 2000, capacity: 50, reserved: 1 });

  const a = { eventId: eventA };
  await insertBooking({ ...a, userId: alice.userId, zoneId: vip, quantity: 2, status: 'CONFIRMED', unitPrice: 5000, paidAgo: '0 seconds' });
  await insertBooking({ ...a, userId: bob.userId, zoneId: ga, quantity: 3, status: 'CONFIRMED', unitPrice: 1000, paidAgo: '2 days' });
  await insertBooking({ eventId: eventB, userId: carol.userId, zoneId: zoneB, quantity: 1, status: 'CONFIRMED', unitPrice: 2000, paidAgo: '0 seconds' });
  await insertBooking({ ...a, userId: carol.userId, zoneId: ga, quantity: 4, unitPrice: 1000 });
  await insertBooking({ ...a, userId: carol.userId, zoneId: ga, quantity: 2, unitPrice: 1000, expiresIn: '-1 minute' });
  await insertBooking({ ...a, userId: bob.userId, zoneId: ga, quantity: 1, status: 'EXPIRED', unitPrice: 1000 });
  await insertBooking({ ...a, userId: bob.userId, zoneId: vip, quantity: 1, status: 'FAILED', failReason: 'SOLD_OUT' });
  await insertBooking({ ...a, userId: alice.userId, zoneId: ga, quantity: 1, status: 'FAILED', failReason: 'USER_LIMIT' });
});

afterAll(closeConnections);

describe('access', () => {
  test.each(['/admin/dashboard', '/admin/events/1/sales', '/admin/reports/sales.csv'])(
    '%s is admin only',
    async (path) => {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await get(path, alice)).status).toBe(403);
    },
  );
});

describe('GET /admin/dashboard', () => {
  test('totals count only CONFIRMED as sold and only live holds as held', async () => {
    const res = await get('/admin/dashboard');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      revenue: 15000,
      ticketsSold: 6,
      ticketsHeld: 4,
      upcomingEvents: 2,
      bookingsByStatus: { PENDING: 1, CONFIRMED: 3, EXPIRED: 2, FAILED: 2 },
      failReasons: { SOLD_OUT: 1, USER_LIMIT: 1 },
    });
  });

  test('top events are ranked by revenue', async () => {
    const res = await get('/admin/dashboard');

    expect(res.body.topEvents).toEqual([
      { eventId: eventA, name: 'Concert A', startsAt: expect.any(String), revenue: 13000, ticketsSold: 5, capacity: 110 },
      { eventId: eventB, name: 'Concert B', startsAt: expect.any(String), revenue: 2000, ticketsSold: 1, capacity: 50 },
    ]);
  });

  test('recent sales list confirmed bookings, newest first', async () => {
    const res = await get('/admin/dashboard');

    expect(res.body.recentSales).toHaveLength(3);
    expect(res.body.recentSales[2]).toMatchObject({ username: 'bob', eventName: 'Concert A', zoneName: 'GA', quantity: 3, total: 3000 });
  });

  test('daily covers the last 14 Bangkok days with no gaps', async () => {
    const res = await get('/admin/dashboard');
    const { daily } = res.body;

    expect(daily).toHaveLength(14);
    expect(daily[13]).toEqual({ date: await bangkokDate(0), tickets: 3, revenue: 12000 });
    expect(daily[11]).toEqual({ date: await bangkokDate(2), tickets: 3, revenue: 3000 });
    expect(daily[12]).toEqual({ date: await bangkokDate(1), tickets: 0, revenue: 0 });
  });

  test('a price change after the sale does not change revenue', async () => {
    await request(app)
      .patch(`/admin/zones/${vip}`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ price: 9999 })
      .expect(200);

    expect((await get('/admin/dashboard')).body.revenue).toBe(15000);
  });

  test('works on an empty database', async () => {
    await resetEvents();

    const res = await get('/admin/dashboard');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ revenue: 0, ticketsSold: 0, ticketsHeld: 0, topEvents: [], recentSales: [] });
  });
});

describe('daily buckets use Bangkok days', () => {
  test('00:30 Bangkok counts as that day even though it is the previous day in UTC', async () => {
    await resetEvents();
    eventA = await insertEvent('Concert A', '30 days');
    ga = await insertZone(eventA, 'GA', { price: 1000, capacity: 100, reserved: 2 });
    const early = await insertBooking({ eventId: eventA, userId: alice.userId, zoneId: ga, status: 'CONFIRMED', unitPrice: 1000, paidAgo: '0 seconds' });
    const late = await insertBooking({ eventId: eventA, userId: bob.userId, zoneId: ga, status: 'CONFIRMED', unitPrice: 1000, paidAgo: '0 seconds' });
    const set = (id, sql) => pool.query(`UPDATE bookings SET paid_at = ${sql} WHERE id = $1`, [id]);
    await set(early, `((now() AT TIME ZONE 'Asia/Bangkok')::date + time '00:30') AT TIME ZONE 'Asia/Bangkok'`);
    await set(late, `((now() AT TIME ZONE 'Asia/Bangkok')::date - 1 + time '23:30') AT TIME ZONE 'Asia/Bangkok'`);

    const { daily } = (await get('/admin/dashboard')).body;

    expect(daily[13].tickets).toBe(1);
    expect(daily[12].tickets).toBe(1);
  });
});

describe('GET /admin/events/:id/sales', () => {
  test('per-zone sales add up to the totals', async () => {
    const res = await get(`/admin/events/${eventA}/sales`);

    expect(res.status).toBe(200);
    expect(res.body.zones).toEqual([
      { zoneId: vip, name: 'VIP', price: 5000, capacity: 10, sold: 2, held: 0, revenue: 10000, available: 8, sellThrough: 0.2 },
      { zoneId: ga, name: 'GA', price: 1000, capacity: 100, sold: 3, held: 4, revenue: 3000, available: 93, sellThrough: 0.03 },
    ]);
    expect(res.body.totals).toEqual({ capacity: 110, sold: 5, held: 4, revenue: 13000, sellThrough: 5 / 110 });
    expect(res.body.event).toMatchObject({ id: eventA, name: 'Concert A' });
  });

  test('daily runs from the first sale (at least 7 days) and only counts this event', async () => {
    const { daily } = (await get(`/admin/events/${eventA}/sales`)).body;

    expect(daily).toHaveLength(7);
    expect(daily.at(-1)).toEqual({ date: await bangkokDate(0), tickets: 2, revenue: 10000 });
    expect(daily.at(-3)).toEqual({ date: await bangkokDate(2), tickets: 3, revenue: 3000 });
  });

  test('an event with no zones or sales', async () => {
    const empty = await insertEvent('Empty', '30 days');

    const res = await get(`/admin/events/${empty}/sales`);

    expect(res.body).toMatchObject({ zones: [], totals: { capacity: 0, sold: 0, revenue: 0, sellThrough: 0 } });
  });

  test('unknown event returns 404', async () => {
    expect((await get('/admin/events/999/sales')).status).toBe(404);
  });
});

describe('GET /admin/reports/sales.csv', () => {
  const rowsOf = (text) => text.replace(/^﻿/, '').trim().split('\r\n');

  test('is a UTF-8 CSV download with a BOM, header and one row per confirmed booking', async () => {
    const res = await get('/admin/reports/sales.csv').buffer(true).parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { data += c; });
      r.on('end', () => cb(null, data));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="sales-${await bangkokDate(0)}.csv"`);
    expect(res.body.startsWith('﻿')).toBe(true);
    const rows = rowsOf(res.body);
    expect(rows[0]).toBe('booking_id,paid_at,event,zone,username,quantity,unit_price,total');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatch(/^[0-9a-f-]{36},\d{4}-\d{2}-\d{2} \d{2}:\d{2},Concert A,GA,bob,3,1000,3000$/);
  });

  test('filters by event and by Bangkok payment date', async () => {
    const text = async (q) => rowsOf((await get(`/admin/reports/sales.csv?${new URLSearchParams(q)}`)).text);

    expect(await text({ eventId: String(eventB) })).toHaveLength(2);
    expect(await text({ from: await bangkokDate(0) })).toHaveLength(3);
    expect(await text({ to: await bangkokDate(1) })).toHaveLength(2);
  });

  test('a formula in an event name is written as text', async () => {
    await pool.query(`UPDATE events SET name = '=HYPERLINK("http://evil","x")' WHERE id = $1`, [eventB]);

    const res = await get('/admin/reports/sales.csv');

    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
  });

  test.each([[{ from: 'yesterday' }], [{ from: '2099-01-02', to: '2099-01-01' }], [{ eventId: 'abc' }]])(
    '%o returns 400',
    async (q) => {
      expect((await get(`/admin/reports/sales.csv?${new URLSearchParams(q)}`)).status).toBe(400);
    },
  );
});

describe('csvField', () => {
  test.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line\nbreak', '"line\nbreak"'],
    ['=1+1', "'=1+1"],
    ['+66', "'+66"],
    ['-x', "'-x"],
    ['@cmd', "'@cmd"],
    [null, ''],
    [1500, '1500'],
  ])('%p -> %p', (input, output) => {
    expect(csvField(input)).toBe(output);
  });
});

describe('worker stores the price at booking time', () => {
  test('PENDING bookings get the zone price, FAILED ones none', async () => {
    const zone = await insertZone(eventB, 'Tiny', { price: 1234, capacity: 1 });
    const book = async (user) => {
      const id = randomUUID();
      await processBooking({ bookingId: id, requestId: id, userId: user.userId, eventId: eventB, zoneId: zone, quantity: 1, requestedAt: new Date().toISOString() });
      const { rows } = await pool.query('SELECT status, unit_price FROM bookings WHERE id = $1', [id]);
      return rows[0];
    };

    expect(await book(alice)).toEqual({ status: 'PENDING', unit_price: 1234 });
    expect(await book(bob)).toEqual({ status: 'FAILED', unit_price: null });
  });
});
