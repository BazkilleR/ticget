// Worker-side booking logic (Phase 5): quota, idempotency, per-user limit, concurrency, and the SQS loop.
const { randomUUID } = require('crypto');
const request = require('supertest');
const { SendMessageCommand } = require('@aws-sdk/client-sqs');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { redis } = require('../src/redis');
const { sqs } = require('../src/sqs');
const bookingService = require('../src/services/booking');
const { processBooking } = bookingService;
const { pollOnce } = require('../src/worker');
const {
  resetUsers,
  resetEvents,
  flushCache,
  closeConnections,
  insertEvent,
  insertZone,
  createUser,
  drainQueue,
} = require('./helpers');

const app = createApp();

let eventId;

function message(userId, zoneId, quantity = 1, overrides = {}) {
  const requestId = randomUUID();
  return {
    bookingId: requestId,
    requestId,
    userId,
    eventId,
    zoneId,
    quantity,
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function zoneReserved(zoneId) {
  const { rows } = await pool.query('SELECT reserved FROM zones WHERE id = $1', [zoneId]);
  return rows[0].reserved;
}

async function bookingRow(id) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [id]);
  return rows[0];
}

async function countByStatus(zoneId) {
  const { rows } = await pool.query(
    `SELECT status, COALESCE(SUM(quantity), 0)::int AS tickets, COUNT(*)::int AS bookings
       FROM bookings WHERE zone_id = $1 GROUP BY status`,
    [zoneId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, r]));
}

beforeAll(() => drainQueue());

beforeEach(async () => {
  await resetUsers();
  await resetEvents();
  await flushCache();
  eventId = await insertEvent('On sale', '30 days');
});

afterEach(async () => {
  jest.restoreAllMocks();
  await drainQueue();
});

afterAll(closeConnections);

describe('processBooking', () => {
  test('reserves seats and creates a PENDING booking held for BOOKING_HOLD_MINUTES', async () => {
    const zoneId = await insertZone(eventId, 'GA', { capacity: 10 });
    const alice = await createUser('alice');
    const msg = message(alice.userId, zoneId, 3);

    const result = await processBooking(msg);

    expect(result).toEqual({ bookingId: msg.bookingId, status: 'PENDING' });
    expect(await zoneReserved(zoneId)).toBe(3);

    const row = await bookingRow(msg.bookingId);
    expect(row).toMatchObject({ request_id: msg.requestId, user_id: alice.userId, quantity: 3, status: 'PENDING' });
    const holdMs = row.expires_at.getTime() - row.created_at.getTime();
    expect(holdMs).toBeCloseTo(config.bookingHoldMinutes * 60_000, -3);
  });

  test('fills the 5-seat zone, then the next request is FAILED / SOLD_OUT', async () => {
    const vip = await insertZone(eventId, 'VIP', { capacity: 5 });
    const users = await Promise.all(['u1', 'u2', 'u3'].map(createUser));

    expect((await processBooking(message(users[0].userId, vip, 4))).status).toBe('PENDING');
    expect((await processBooking(message(users[1].userId, vip, 1))).status).toBe('PENDING');
    const last = message(users[2].userId, vip, 1);
    const result = await processBooking(last);

    expect(result).toEqual({ bookingId: last.bookingId, status: 'FAILED', failReason: 'SOLD_OUT' });
    expect(await zoneReserved(vip)).toBe(5);
    expect(await bookingRow(last.bookingId)).toMatchObject({ status: 'FAILED', fail_reason: 'SOLD_OUT' });
  });

  test('never reserves part of a request: 2 seats wanted, 1 left -> SOLD_OUT', async () => {
    const zoneId = await insertZone(eventId, 'GA', { capacity: 5, reserved: 4 });
    const alice = await createUser('alice');

    const result = await processBooking(message(alice.userId, zoneId, 2));

    expect(result.failReason).toBe('SOLD_OUT');
    expect(await zoneReserved(zoneId)).toBe(4);
  });

  test('the same message processed twice creates one booking and reserves once', async () => {
    const zoneId = await insertZone(eventId, 'GA', { capacity: 10 });
    const alice = await createUser('alice');
    const msg = message(alice.userId, zoneId, 2);

    await processBooking(msg);
    const again = await processBooking(msg);

    expect(again).toEqual({ bookingId: msg.bookingId, status: 'PENDING', duplicate: true });
    expect(await zoneReserved(zoneId)).toBe(2);
    expect((await countByStatus(zoneId)).PENDING.bookings).toBe(1);
  });

  test('the same message processed by 5 workers at once still reserves once', async () => {
    const zoneId = await insertZone(eventId, 'GA', { capacity: 10 });
    const alice = await createUser('alice');
    const msg = message(alice.userId, zoneId, 2);

    const results = await Promise.all(Array.from({ length: 5 }, () => processBooking(msg)));

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await zoneReserved(zoneId)).toBe(2);
    expect((await countByStatus(zoneId)).PENDING.bookings).toBe(1);
  });

  test('a duplicate of a FAILED request stays FAILED and does not retry the reservation', async () => {
    const zoneId = await insertZone(eventId, 'GA', { capacity: 1, reserved: 1 });
    const alice = await createUser('alice');
    const msg = message(alice.userId, zoneId, 1);

    await processBooking(msg);
    await pool.query('UPDATE zones SET reserved = 0 WHERE id = $1', [zoneId]); // a seat frees up later

    expect(await processBooking(msg)).toMatchObject({ status: 'FAILED', duplicate: true });
    expect(await zoneReserved(zoneId)).toBe(0);
  });

  describe('per-user limit (MAX_TICKETS_PER_USER = 4 per event)', () => {
    test('3 then 2 tickets in the same event -> second is FAILED / USER_LIMIT', async () => {
      const ga = await insertZone(eventId, 'GA', { capacity: 100 });
      const vip = await insertZone(eventId, 'VIP', { capacity: 100 });
      const alice = await createUser('alice');

      expect((await processBooking(message(alice.userId, ga, 3))).status).toBe('PENDING');
      const second = await processBooking(message(alice.userId, vip, 2));

      expect(second).toMatchObject({ status: 'FAILED', failReason: 'USER_LIMIT' });
      expect(await zoneReserved(vip)).toBe(0);
    });

    test('exactly 4 is allowed', async () => {
      const ga = await insertZone(eventId, 'GA', { capacity: 100 });
      const alice = await createUser('alice');

      await processBooking(message(alice.userId, ga, 3));
      expect((await processBooking(message(alice.userId, ga, 1))).status).toBe('PENDING');
    });

    test('CONFIRMED counts, FAILED and expired holds do not', async () => {
      const ga = await insertZone(eventId, 'GA', { capacity: 100 });
      const alice = await createUser('alice');

      const confirmed = message(alice.userId, ga, 2);
      await processBooking(confirmed);
      await pool.query(`UPDATE bookings SET status = 'CONFIRMED' WHERE id = $1`, [confirmed.bookingId]);

      const expired = message(alice.userId, ga, 2);
      await processBooking(expired);
      await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [
        expired.bookingId,
      ]);

      await processBooking(message(alice.userId, ga, 4)); // FAILED USER_LIMIT: 2 confirmed + 4 > 4

      expect((await processBooking(message(alice.userId, ga, 2))).status).toBe('PENDING');
    });

    test('other events do not count', async () => {
      const ga = await insertZone(eventId, 'GA', { capacity: 100 });
      const otherEvent = await insertEvent('Other', '30 days');
      const otherZone = await insertZone(otherEvent, 'GA', { capacity: 100 });
      const alice = await createUser('alice');

      await processBooking(message(alice.userId, otherZone, 4, { eventId: otherEvent }));
      expect((await processBooking(message(alice.userId, ga, 4))).status).toBe('PENDING');
    });

    test('two zones processed in parallel cannot together exceed the limit', async () => {
      const ga = await insertZone(eventId, 'GA', { capacity: 100 });
      const vip = await insertZone(eventId, 'VIP', { capacity: 100 });
      const alice = await createUser('alice');

      const results = await Promise.all([
        processBooking(message(alice.userId, ga, 3)),
        processBooking(message(alice.userId, vip, 3)),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(['FAILED', 'PENDING']);
      expect((await zoneReserved(ga)) + (await zoneReserved(vip))).toBe(3);
    });
  });

  test('releases expired holds in the zone before reserving', async () => {
    const zoneId = await insertZone(eventId, 'VIP', { capacity: 5 });
    const [alice, bob] = await Promise.all([createUser('alice'), createUser('bob')]);
    const old = message(alice.userId, zoneId, 4);
    await processBooking(old);
    await processBooking(message(bob.userId, zoneId, 1));
    await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [old.bookingId]);

    const carol = await createUser('carol');
    const result = await processBooking(message(carol.userId, zoneId, 3));

    expect(result.status).toBe('PENDING');
    expect((await bookingRow(old.bookingId)).status).toBe('EXPIRED');
    expect(await zoneReserved(zoneId)).toBe(4); // bob 1 + carol 3
  });

  test('50 parallel requests for a 10-seat zone: exactly 10 succeed, never oversold', async () => {
    const zoneId = await insertZone(eventId, 'GA', { capacity: 10 });
    const users = await Promise.all(Array.from({ length: 50 }, (_, i) => createUser(`user${i}`)));

    const results = await Promise.all(users.map((u) => processBooking(message(u.userId, zoneId, 1))));

    expect(results.filter((r) => r.status === 'PENDING')).toHaveLength(10);
    expect(results.filter((r) => r.failReason === 'SOLD_OUT')).toHaveLength(40);
    expect(await zoneReserved(zoneId)).toBe(10);
    expect((await countByStatus(zoneId)).PENDING.tickets).toBe(10);
  });

  test('clears the cached zone list after processing', async () => {
    const zoneId = await insertZone(eventId, 'GA');
    const alice = await createUser('alice');
    await redis.set(`event:${eventId}:zones`, '[]');

    await processBooking(message(alice.userId, zoneId, 1));

    expect(await redis.exists(`event:${eventId}:zones`)).toBe(0);
  });

  test('rolls back everything if the insert fails', async () => {
    const zoneId = await insertZone(eventId, 'GA', { capacity: 10 });
    const alice = await createUser('alice');
    // Wrong eventId: the FK on bookings.event_id fails after the zone was already incremented.
    const bad = message(alice.userId, zoneId, 2, { eventId: 999 });

    await expect(processBooking(bad)).rejects.toThrow();
    expect(await zoneReserved(zoneId)).toBe(0);
    expect(await bookingRow(bad.bookingId)).toBeUndefined();
  });

  test.each([
    ['unknown user', (m) => ({ ...m, userId: randomUUID() })],
    ['quantity 5', (m) => ({ ...m, quantity: 5 })],
    ['missing requestId', ({ requestId, ...m }) => m],
  ])('rejects a bad message (%s)', async (_name, mutate) => {
    const zoneId = await insertZone(eventId, 'GA');
    const alice = await createUser('alice');

    await expect(processBooking(mutate(message(alice.userId, zoneId)))).rejects.toThrow();
  });
});

describe('worker loop (pollOnce) against the SQS test queue', () => {
  const fast = { waitSeconds: 2 };

  test('POST /bookings -> worker -> GET /bookings/:id is PENDING, and the message is deleted', async () => {
    const zoneId = await insertZone(eventId, 'GA', { capacity: 10 });
    const alice = await createUser('alice');
    const requestId = randomUUID();
    const auth = { Authorization: `Bearer ${alice.token}` };

    await request(app).post('/bookings').set(auth).send({ eventId, zoneId, quantity: 2, requestId }).expect(202);
    expect((await request(app).get(`/bookings/${requestId}`).set(auth)).body.status).toBe('QUEUED');

    const stats = await pollOnce(fast);

    expect(stats).toMatchObject({ received: 1, processed: 1, failed: 0 });
    const res = await request(app).get(`/bookings/${requestId}`).set(auth);
    expect(res.body).toMatchObject({ bookingId: requestId, status: 'PENDING', quantity: 2 });
    expect(await drainQueue()).toHaveLength(0);
  });

  test('a failing message is not deleted, so SQS redelivers it', async () => {
    const zoneId = await insertZone(eventId, 'GA');
    const alice = await createUser('alice');
    const msg = message(alice.userId, zoneId);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: config.sqsBookingQueueUrl,
        MessageBody: JSON.stringify(msg),
        MessageGroupId: `zone-${zoneId}`,
        MessageDeduplicationId: msg.requestId,
      }),
    );
    jest.spyOn(bookingService, 'processBooking').mockRejectedValueOnce(new Error('db down'));

    // Short visibility timeout so the redelivery happens within the test.
    const first = await pollOnce({ ...fast, visibilityTimeout: 1 });
    expect(first).toMatchObject({ received: 1, processed: 0, failed: 1 });
    expect(await bookingRow(msg.bookingId)).toBeUndefined();

    await new Promise((r) => setTimeout(r, 1500));
    const second = await pollOnce(fast);
    expect(second).toMatchObject({ received: 1, processed: 1 });
    expect((await bookingRow(msg.bookingId)).status).toBe('PENDING');
  });

  test('messages for one zone are processed in order, first come first served', async () => {
    const vip = await insertZone(eventId, 'VIP', { capacity: 2 });
    const users = await Promise.all(['u1', 'u2', 'u3'].map(createUser));
    const msgs = users.map((u) => message(u.userId, vip, 1));
    for (const m of msgs) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: config.sqsBookingQueueUrl,
          MessageBody: JSON.stringify(m),
          MessageGroupId: `zone-${vip}`,
          MessageDeduplicationId: m.requestId,
        }),
      );
    }

    await pollOnce(fast);

    const statuses = [];
    for (const m of msgs) statuses.push((await bookingRow(m.bookingId)).status);
    expect(statuses).toEqual(['PENDING', 'PENDING', 'FAILED']);
  });
});
