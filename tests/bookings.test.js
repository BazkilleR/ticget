const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { sqs } = require('../src/sqs');
const {
  resetUsers,
  resetEvents,
  closeConnections,
  insertEvent,
  insertZone,
  createUser,
  drainQueue,
} = require('./helpers');

const app = createApp();

let alice;
let bob;
let eventId;
let zoneId;

async function insertBooking(userId, fields = {}) {
  const b = {
    id: randomUUID(),
    quantity: 2,
    status: 'PENDING',
    failReason: null,
    expiresIn: '10 minutes',
    ...fields,
  };
  await pool.query(
    `INSERT INTO bookings (id, request_id, user_id, event_id, zone_id, quantity, status, fail_reason, expires_at)
     VALUES ($1, $1, $2, $3, $4, $5, $6, $7, now() + $8::interval)`,
    [b.id, userId, eventId, zoneId, b.quantity, b.status, b.failReason, b.expiresIn],
  );
  return b.id;
}

const book = (token, body) =>
  request(app).post('/bookings').set('Authorization', `Bearer ${token}`).send(body);

beforeAll(() => drainQueue());

beforeEach(async () => {
  await resetUsers();
  await resetEvents();
  alice = await createUser('alice');
  bob = await createUser('bob');
  eventId = await insertEvent('On sale', '30 days');
  zoneId = await insertZone(eventId, 'GA', { capacity: 100 });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await drainQueue();
});

afterAll(closeConnections);

describe('POST /bookings', () => {
  test('without a token returns 401', async () => {
    const res = await request(app)
      .post('/bookings')
      .send({ eventId, zoneId, quantity: 1, requestId: randomUUID() });

    expect(res.status).toBe(401);
  });

  test('returns 202 QUEUED and puts the message on the FIFO queue', async () => {
    const requestId = randomUUID();

    const res = await book(alice.token, { eventId, zoneId, quantity: 2, requestId });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ bookingId: requestId, status: 'QUEUED' });

    const messages = await drainQueue({ waitSeconds: 2 });
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toEqual({
      bookingId: requestId,
      requestId,
      userId: alice.userId,
      eventId,
      zoneId,
      quantity: 2,
      requestedAt: expect.any(String),
    });
    expect(messages[0].attributes.MessageGroupId).toBe(`zone-${zoneId}`);
    expect(messages[0].attributes.MessageDeduplicationId).toBe(requestId);
  });

  test('ignores a userId in the body and uses the one from the JWT', async () => {
    await book(alice.token, { eventId, zoneId, quantity: 1, requestId: randomUUID(), userId: bob.userId })
      .expect(202);

    const [message] = await drainQueue({ waitSeconds: 2 });
    expect(message.body.userId).toBe(alice.userId);
  });

  test('the same requestId sent twice is queued only once', async () => {
    const body = { eventId, zoneId, quantity: 1, requestId: randomUUID() };

    await book(alice.token, body).expect(202);
    await book(alice.token, body).expect(202);

    const messages = await drainQueue({ waitSeconds: 2 });
    expect(messages).toHaveLength(1);
  });

  test.each([
    ['quantity 0', { quantity: 0 }],
    ['quantity 5', { quantity: 5 }],
    ['fractional quantity', { quantity: 1.5 }],
    ['non-UUID requestId', { requestId: 'abc' }],
    ['missing zoneId', { zoneId: undefined }],
    ['eventId as a string', { eventId: '1' }],
  ])('%s returns 400 validation_error', async (_name, override) => {
    const res = await book(alice.token, { eventId, zoneId, quantity: 1, requestId: randomUUID(), ...override });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  test('zone from a different event returns 404 zone_not_found', async () => {
    const otherEvent = await insertEvent('Other', '30 days');
    const otherZone = await insertZone(otherEvent, 'GA');

    const res = await book(alice.token, { eventId, zoneId: otherZone, quantity: 1, requestId: randomUUID() });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('zone_not_found');
  });

  test('before sale opens returns 409 sale_not_open', async () => {
    const early = await insertEvent('Not yet', '30 days', '7 days');
    const earlyZone = await insertZone(early, 'GA');

    const res = await book(alice.token, { eventId: early, zoneId: earlyZone, quantity: 1, requestId: randomUUID() });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sale_not_open');
  });

  test('after the event started returns 409 sale_closed', async () => {
    const past = await insertEvent('Started', '-1 hour', '-7 days');
    const pastZone = await insertZone(past, 'GA');

    const res = await book(alice.token, { eventId: past, zoneId: pastZone, quantity: 1, requestId: randomUUID() });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('sale_closed');
  });

  test('rejected requests put nothing on the queue', async () => {
    await book(alice.token, { eventId, zoneId: 999, quantity: 1, requestId: randomUUID() }).expect(404);

    expect(await drainQueue({ waitSeconds: 1 })).toHaveLength(0);
  });

  test('SQS failure returns 503 queue_unavailable', async () => {
    jest.spyOn(sqs, 'send').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await book(alice.token, { eventId, zoneId, quantity: 1, requestId: randomUUID() });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('queue_unavailable');
  });
});

describe('GET /bookings/:id', () => {
  const get = (token, id) => request(app).get(`/bookings/${id}`).set('Authorization', `Bearer ${token}`);

  test('without a token returns 401', async () => {
    const res = await request(app).get(`/bookings/${randomUUID()}`);

    expect(res.status).toBe(401);
  });

  test('a booking the worker has not processed yet is QUEUED', async () => {
    const requestId = randomUUID();
    await book(alice.token, { eventId, zoneId, quantity: 1, requestId }).expect(202);

    const res = await get(alice.token, requestId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookingId: requestId, status: 'QUEUED' });
  });

  test('returns the booking from the database', async () => {
    const id = await insertBooking(alice.userId, { quantity: 3 });

    const res = await get(alice.token, id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      bookingId: id,
      eventId,
      eventName: 'On sale',
      zoneId,
      zoneName: 'GA',
      quantity: 3,
      status: 'PENDING',
      failReason: null,
      expiresAt: expect.any(String),
      createdAt: expect.any(String),
    });
  });

  test('returns FAILED bookings with their reason', async () => {
    const id = await insertBooking(alice.userId, { status: 'FAILED', failReason: 'SOLD_OUT' });

    const res = await get(alice.token, id);

    expect(res.body.status).toBe('FAILED');
    expect(res.body.failReason).toBe('SOLD_OUT');
  });

  test("another user's booking looks exactly like one that does not exist", async () => {
    const id = await insertBooking(alice.userId);

    const res = await get(bob.token, id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookingId: id, status: 'QUEUED' });
  });

  test('a PENDING booking past its hold is reported as EXPIRED', async () => {
    const id = await insertBooking(alice.userId, { expiresIn: '-1 minute' });

    const res = await get(alice.token, id);

    expect(res.body.status).toBe('EXPIRED');
  });

  test('non-UUID id returns 400 validation_error', async () => {
    const res = await get(alice.token, 'not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });
});

describe('GET /me/bookings', () => {
  test('without a token returns 401', async () => {
    const res = await request(app).get('/me/bookings');

    expect(res.status).toBe(401);
  });

  test("returns only the caller's bookings, newest first", async () => {
    const older = await insertBooking(alice.userId);
    await pool.query(`UPDATE bookings SET created_at = now() - interval '1 hour' WHERE id = $1`, [older]);
    const newer = await insertBooking(alice.userId, { status: 'CONFIRMED' });
    await insertBooking(bob.userId);

    const res = await request(app).get('/me/bookings').set('Authorization', `Bearer ${alice.token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((b) => b.bookingId)).toEqual([newer, older]);
    expect(res.body[0].status).toBe('CONFIRMED');
  });

  test('returns an empty list for a user with no bookings', async () => {
    const res = await request(app).get('/me/bookings').set('Authorization', `Bearer ${bob.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
