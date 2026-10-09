// e-tickets issued on payment, and door check-in (Phase 13).
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
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

let eventId;
let zoneId;
let alice;
let bob;
let admin;

const as = (who) => ({ Authorization: `Bearer ${who.token}` });

async function book(user, quantity = 1) {
  const id = randomUUID();
  await processBooking({
    bookingId: id,
    requestId: id,
    userId: user.userId,
    eventId,
    zoneId,
    quantity,
    requestedAt: new Date().toISOString(),
  });
  return id;
}

const pay = (user, id) => request(app).post(`/bookings/${id}/pay`).set(as(user));
const tickets = (user, id) => request(app).get(`/bookings/${id}/tickets`).set(as(user));
const checkIn = (body, who = admin) => request(app).post('/admin/tickets/check-in').set(as(who)).send(body);

async function ticketRows(bookingId) {
  const { rows } = await pool.query('SELECT * FROM tickets WHERE booking_id = $1 ORDER BY seq', [bookingId]);
  return rows;
}

async function paidTicket(quantity = 1) {
  const id = await book(alice, quantity);
  await pay(alice, id).expect(200);
  return { bookingId: id, codes: (await ticketRows(id)).map((t) => t.code) };
}

beforeEach(async () => {
  await resetUsers();
  await resetEvents();
  await flushCache();
  eventId = await insertEvent('Concert', '30 days');
  zoneId = await insertZone(eventId, 'GA', { capacity: 20 });
  alice = await createUser('alice');
  bob = await createUser('bob');
  admin = await createUser('boss', { role: 'admin' });
});

afterAll(closeConnections);

describe('issuing tickets on payment', () => {
  test('paying issues one ticket per seat with unique 32-hex codes and sets paidAt', async () => {
    const id = await book(alice, 3);

    await pay(alice, id).expect(200);

    const rows = await ticketRows(id);
    expect(rows.map((t) => t.seq)).toEqual([1, 2, 3]);
    rows.forEach((t) => expect(t.code).toMatch(/^[0-9a-f]{32}$/));
    expect(new Set(rows.map((t) => t.code)).size).toBe(3);
    const booking = await request(app).get(`/bookings/${id}`).set(as(alice));
    expect(booking.body.paidAt).toEqual(expect.any(String));
  });

  test('paying again does not issue more tickets', async () => {
    const id = await book(alice, 2);
    await pay(alice, id).expect(200);

    await pay(alice, id).expect(200);

    expect(await ticketRows(id)).toHaveLength(2);
  });

  test('two concurrent payments issue the tickets once', async () => {
    const id = await book(alice, 4);

    const results = await Promise.all([pay(alice, id), pay(alice, id), pay(alice, id)]);

    results.forEach((res) => expect(res.status).toBe(200));
    expect(await ticketRows(id)).toHaveLength(4);
  });

  test('an expired hold cannot be paid and gets no tickets', async () => {
    const id = await book(alice, 2);
    await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);

    await pay(alice, id).expect(409);

    expect(await ticketRows(id)).toHaveLength(0);
  });
});

describe('GET /bookings/:id/tickets', () => {
  test('returns the tickets with event and zone details', async () => {
    const { bookingId } = await paidTicket(2);

    const res = await tickets(alice, bookingId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      bookingId,
      status: 'CONFIRMED',
      quantity: 2,
      paidAt: expect.any(String),
      event: { id: eventId, name: 'Concert', venue: 'Test Venue', startsAt: expect.any(String) },
      zone: { id: zoneId, name: 'GA' },
      tickets: [
        { ticketId: expect.any(String), seq: 1, code: expect.stringMatching(/^[0-9a-f]{32}$/), checkedInAt: null },
        { ticketId: expect.any(String), seq: 2, code: expect.stringMatching(/^[0-9a-f]{32}$/), checkedInAt: null },
      ],
    });
  });

  test('a PENDING booking has no tickets yet', async () => {
    const id = await book(alice, 2);

    const res = await tickets(alice, id);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PENDING', tickets: [] });
  });

  test("someone else's booking looks the same as a missing one", async () => {
    const { bookingId } = await paidTicket();

    const other = await tickets(bob, bookingId);
    const missing = await tickets(bob, randomUUID());

    expect(other.status).toBe(404);
    expect(other.body).toEqual(missing.body);
    expect(other.body.error).toBe('booking_not_found');
  });

  test('requires a token and a uuid', async () => {
    expect((await request(app).get(`/bookings/${randomUUID()}/tickets`)).status).toBe(401);
    expect((await tickets(alice, 'not-a-uuid')).status).toBe(400);
  });
});

describe('POST /admin/tickets/check-in', () => {
  test('first scan admits and records who and when', async () => {
    const { codes } = await paidTicket();

    const res = await checkIn({ code: codes[0], eventId });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      code: codes[0],
      seq: 1,
      quantity: 1,
      username: 'alice',
      eventId,
      eventName: 'Concert',
      zoneName: 'GA',
      checkedInAt: expect.any(String),
    });
    const { rows } = await pool.query('SELECT checked_in_by FROM tickets WHERE code = $1', [codes[0]]);
    expect(rows[0].checked_in_by).toBe(admin.userId);
  });

  test('a second scan is refused as already used, with the time it was used', async () => {
    const { codes } = await paidTicket();
    const first = await checkIn({ code: codes[0], eventId }).expect(200);

    const res = await checkIn({ code: codes[0], eventId });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ticket_already_used');
    expect(res.body.message).toContain(new Date(first.body.checkedInAt).toISOString());
  });

  test('each seat of a booking is checked in separately', async () => {
    const { codes } = await paidTicket(2);

    await checkIn({ code: codes[0], eventId }).expect(200);

    await checkIn({ code: codes[1], eventId }).expect(200);
  });

  test('two gates scanning the same ticket at once admit it only once', async () => {
    const { codes } = await paidTicket();

    const results = await Promise.all([1, 2, 3].map(() => checkIn({ code: codes[0], eventId })));

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });

  test('a ticket for another event is refused', async () => {
    const { codes } = await paidTicket();
    const otherEvent = await insertEvent('Other show', '40 days');

    const res = await checkIn({ code: codes[0], eventId: otherEvent });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ticket_wrong_event');
    const { rows } = await pool.query('SELECT checked_in_at FROM tickets WHERE code = $1', [codes[0]]);
    expect(rows[0].checked_in_at).toBeNull();
  });

  test('an unknown code is 404 and a malformed one is 400', async () => {
    expect((await checkIn({ code: 'a'.repeat(32), eventId })).status).toBe(404);
    expect((await checkIn({ code: 'not-a-code', eventId })).status).toBe(400);
  });

  test('codes typed in upper case with spaces still work', async () => {
    const { codes } = await paidTicket();

    const res = await checkIn({ code: `  ${codes[0].toUpperCase()} `, eventId });

    expect(res.status).toBe(200);
  });

  test('normal users cannot check in or look up tickets', async () => {
    const { codes } = await paidTicket();

    expect((await checkIn({ code: codes[0], eventId }, alice)).status).toBe(403);
    expect((await request(app).get(`/admin/tickets/${codes[0]}`).set(as(alice))).status).toBe(403);
  });
});

describe('GET /admin/tickets/:code', () => {
  test('shows the ticket without checking it in', async () => {
    const { codes } = await paidTicket();

    const res = await request(app).get(`/admin/tickets/${codes[0]}`).set(as(admin));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code: codes[0], username: 'alice', checkedInAt: null });
  });

  test('unknown code returns 404 ticket_not_found', async () => {
    const res = await request(app).get(`/admin/tickets/${'b'.repeat(32)}`).set(as(admin));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('ticket_not_found');
  });
});

describe('migration 004 backfill', () => {
  test('issues tickets for bookings that were CONFIRMED before the migration', async () => {
    const id = await insertBooking({ userId: alice.userId, eventId, zoneId, quantity: 3, status: 'CONFIRMED' });
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_tickets.sql'), 'utf8');
    const backfill = sql.slice(sql.indexOf('INSERT INTO tickets'));

    await pool.query(backfill);

    expect((await ticketRows(id)).map((t) => t.seq)).toEqual([1, 2, 3]);
  });
});
