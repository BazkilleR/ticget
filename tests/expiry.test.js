// Phase 6: mock payment and hold expiry (worker-side release is covered in booking.test.js).
const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { redis } = require('../src/redis');
const { processBooking } = require('../src/services/booking');
const { expireAll } = require('../src/jobs/expire');
const {
  resetUsers,
  resetEvents,
  flushCache,
  closeConnections,
  insertEvent,
  insertZone,
  createUser,
} = require('./helpers');

const app = createApp();

let eventId;
let zoneId;
let alice;
let bob;

// Books through the real worker logic, so zones.reserved is kept consistent with the bookings table.
async function book(user, quantity = 1, zone = zoneId, event = eventId) {
  const id = randomUUID();
  await processBooking({
    bookingId: id,
    requestId: id,
    userId: user.userId,
    eventId: event,
    zoneId: zone,
    quantity,
    requestedAt: new Date().toISOString(),
  });
  return id;
}

// Simulates the hold running out without waiting BOOKING_HOLD_MINUTES.
const expire = (id) =>
  pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);

const pay = (user, id) =>
  request(app).post(`/bookings/${id}/pay`).set('Authorization', `Bearer ${user.token}`);

async function reserved(zone = zoneId) {
  const { rows } = await pool.query('SELECT reserved FROM zones WHERE id = $1', [zone]);
  return rows[0].reserved;
}

async function status(id) {
  const { rows } = await pool.query('SELECT status FROM bookings WHERE id = $1', [id]);
  return rows[0].status;
}

beforeEach(async () => {
  await resetUsers();
  await resetEvents();
  await flushCache();
  eventId = await insertEvent('On sale', '30 days');
  zoneId = await insertZone(eventId, 'GA', { capacity: 10 });
  alice = await createUser('alice');
  bob = await createUser('bob');
});

afterAll(closeConnections);

describe('POST /bookings/:id/pay', () => {
  test('without a token returns 401', async () => {
    const res = await request(app).post(`/bookings/${randomUUID()}/pay`);

    expect(res.status).toBe(401);
  });

  test('paying before the hold expires confirms the booking; reserved does not change', async () => {
    const id = await book(alice, 2);

    const res = await pay(alice, id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookingId: id, status: 'CONFIRMED' });
    expect(await status(id)).toBe('CONFIRMED');
    expect(await reserved()).toBe(2);
  });

  test('paying twice is fine: the retry also returns 200 CONFIRMED', async () => {
    const id = await book(alice);

    await pay(alice, id).expect(200);
    const again = await pay(alice, id);

    expect(again.status).toBe(200);
    expect(again.body.status).toBe('CONFIRMED');
  });

  test('paying after the hold expired returns 409 booking_not_payable', async () => {
    const id = await book(alice);
    await expire(id);

    const res = await pay(alice, id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('booking_not_payable');
    expect(await status(id)).not.toBe('CONFIRMED');
  });

  test('a FAILED booking cannot be paid', async () => {
    const full = await insertZone(eventId, 'Full', { capacity: 1, reserved: 1 });
    const id = await book(alice, 1, full);
    expect(await status(id)).toBe('FAILED');

    const res = await pay(alice, id);

    expect(res.status).toBe(409);
  });

  test("someone else's booking cannot be paid and gets the same answer as an unknown id", async () => {
    const id = await book(alice);

    const other = await pay(bob, id);
    const unknown = await pay(bob, randomUUID());

    expect(other.status).toBe(409);
    expect(other.body).toEqual(unknown.body);
    expect(await status(id)).toBe('PENDING');
  });

  test('non-UUID id returns 400 validation_error', async () => {
    const res = await pay(alice, 'abc');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  test('pay and expiry racing on the same booking: exactly one of them wins', async () => {
    const id = await book(alice, 3);
    // Expires "now": whichever statement runs first decides the outcome, never both.
    await pool.query(`UPDATE bookings SET expires_at = now() + interval '50 milliseconds' WHERE id = $1`, [id]);
    await new Promise((r) => setTimeout(r, 60));

    const [payRes] = await Promise.all([pay(alice, id), expireAll()]);

    const final = await status(id);
    if (payRes.status === 200) {
      expect(final).toBe('CONFIRMED');
      expect(await reserved()).toBe(3);
    } else {
      expect(final).toBe('EXPIRED');
      expect(await reserved()).toBe(0);
    }
  });
});

describe('cleanup job: expireAll()', () => {
  test('releases expired holds in every zone and event, and returns what it did', async () => {
    const vip = await insertZone(eventId, 'VIP', { capacity: 5 });
    const otherEvent = await insertEvent('Other', '40 days');
    const otherZone = await insertZone(otherEvent, 'GA', { capacity: 10 });

    const a = await book(alice, 2);
    const b = await book(alice, 1, vip);
    const c = await book(bob, 4, otherZone, otherEvent);
    await Promise.all([a, b, c].map(expire));

    const summary = await expireAll();

    expect(summary).toEqual({ zones: 3, tickets: 7, failedZones: 0 });
    expect([await status(a), await status(b), await status(c)]).toEqual(['EXPIRED', 'EXPIRED', 'EXPIRED']);
    expect([await reserved(), await reserved(vip), await reserved(otherZone)]).toEqual([0, 0, 0]);
  });

  test('leaves live PENDING and CONFIRMED bookings alone, even a CONFIRMED one whose hold time has passed', async () => {
    const live = await book(alice, 1);
    const paid = await book(alice, 2);
    await pay(alice, paid).expect(200);
    await expire(paid); // expires_at in the past no longer matters once CONFIRMED
    const gone = await book(bob, 3);
    await expire(gone);

    await expireAll();

    expect(await status(live)).toBe('PENDING');
    expect(await status(paid)).toBe('CONFIRMED');
    expect(await status(gone)).toBe('EXPIRED');
    expect(await reserved()).toBe(3); // 1 live + 2 paid
  });

  test('running it twice releases the seats only once', async () => {
    const id = await book(alice, 2);
    await book(bob, 1);
    await expire(id);

    await expireAll();
    const second = await expireAll();

    expect(second).toEqual({ zones: 0, tickets: 0, failedZones: 0 });
    expect(await reserved()).toBe(1);
  });

  test('clears the zone cache of affected events only', async () => {
    const otherEvent = await insertEvent('Untouched', '40 days');
    const id = await book(alice);
    await expire(id);
    await redis.set(`event:${eventId}:zones`, '[]');
    await redis.set(`event:${otherEvent}:zones`, '[]');

    await expireAll();

    expect(await redis.exists(`event:${eventId}:zones`)).toBe(0);
    expect(await redis.exists(`event:${otherEvent}:zones`)).toBe(1);
  });

  test('released seats can be booked again: sold-out zone -> hold expires -> next buyer succeeds', async () => {
    const vip = await insertZone(eventId, 'VIP', { capacity: 5 });
    const first = await book(alice, 4, vip);
    await book(bob, 1, vip);
    const carol = await createUser('carol');
    const tooLate = await book(carol, 1, vip);
    expect(await status(tooLate)).toBe('FAILED');

    await expire(first);
    await expireAll();
    const dave = await createUser('dave');
    const retry = await book(dave, 4, vip);

    expect(await status(retry)).toBe('PENDING');
    expect(await reserved(vip)).toBe(5);
  });

  test('GET /events/:id/zones shows the seats again after expiry', async () => {
    const id = await book(alice, 4);
    await expire(id);
    await expireAll();

    const res = await request(app).get(`/events/${eventId}/zones`);

    expect(res.body[0].available).toBe(10);
  });
});
