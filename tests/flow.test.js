// End-to-end user journeys through the HTTP API, SQS (test queue) and the real worker loop.
const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { pollOnce } = require('../src/worker');
const { expireAll } = require('../src/jobs/expire');
const {
  resetUsers,
  resetEvents,
  flushCache,
  closeConnections,
  insertEvent,
  insertZone,
  drainQueue,
} = require('./helpers');

const app = createApp();

async function signUp(username) {
  await request(app).post('/auth/register').send({ username, password: 'password123' }).expect(201);
  const login = await request(app).post('/auth/login').send({ username, password: 'password123' }).expect(200);
  return { Authorization: `Bearer ${login.body.token}` };
}

// Drains the queue through the real worker loop until nothing is left.
async function runWorker() {
  for (;;) {
    const stats = await pollOnce({ waitSeconds: 1 });
    if (stats.received === 0) return;
  }
}

beforeAll(() => drainQueue());

beforeEach(async () => {
  await resetUsers();
  await resetEvents();
  await flushCache();
});

afterEach(() => drainQueue());
afterAll(closeConnections);

test('register -> login -> browse -> book -> worker -> pay -> history', async () => {
  const eventId = await insertEvent('Concert A', '30 days');
  const zoneId = await insertZone(eventId, 'VIP', { price: 5000, capacity: 5 });
  const auth = await signUp('alice');

  const events = await request(app).get('/events').expect(200);
  expect(events.body.map((e) => e.id)).toContain(eventId);

  const zones = await request(app).get(`/events/${eventId}/zones`).expect(200);
  expect(zones.body).toEqual([{ zoneId, name: 'VIP', price: 5000, available: 5 }]);

  const requestId = randomUUID();
  const booked = await request(app)
    .post('/bookings')
    .set(auth)
    .send({ eventId, zoneId, quantity: 2, requestId })
    .expect(202);
  expect(booked.body).toEqual({ bookingId: requestId, status: 'QUEUED' });
  expect((await request(app).get(`/bookings/${requestId}`).set(auth)).body.status).toBe('QUEUED');

  await runWorker();

  const pending = await request(app).get(`/bookings/${requestId}`).set(auth).expect(200);
  expect(pending.body).toMatchObject({ status: 'PENDING', quantity: 2, zoneName: 'VIP' });

  // The worker cleared the cache, so availability is fresh immediately.
  const after = await request(app).get(`/events/${eventId}/zones`).expect(200);
  expect(after.body[0].available).toBe(3);

  await request(app).post(`/bookings/${requestId}/pay`).set(auth).expect(200, {
    bookingId: requestId,
    status: 'CONFIRMED',
  });

  const history = await request(app).get('/me/bookings').set(auth).expect(200);
  expect(history.body).toHaveLength(1);
  expect(history.body[0]).toMatchObject({ bookingId: requestId, status: 'CONFIRMED' });
});

test('sold out: 5-seat zone, 3 buyers x 2 tickets -> first two succeed, third gets SOLD_OUT', async () => {
  const eventId = await insertEvent('Concert A', '30 days');
  const zoneId = await insertZone(eventId, 'VIP', { capacity: 5 });
  const buyers = [await signUp('buyer1'), await signUp('buyer2'), await signUp('buyer3')];
  const ids = [];

  for (const auth of buyers) {
    const requestId = randomUUID();
    ids.push(requestId);
    await request(app).post('/bookings').set(auth).send({ eventId, zoneId, quantity: 2, requestId }).expect(202);
  }
  await runWorker();

  const results = [];
  for (let i = 0; i < buyers.length; i++) {
    results.push((await request(app).get(`/bookings/${ids[i]}`).set(buyers[i])).body);
  }
  expect(results.map((b) => b.status)).toEqual(['PENDING', 'PENDING', 'FAILED']);
  expect(results[2].failReason).toBe('SOLD_OUT');

  const zones = await request(app).get(`/events/${eventId}/zones`).expect(200);
  expect(zones.body[0].available).toBe(1);
});

test('hold expires unpaid -> pay is refused -> seats return for the next buyer', async () => {
  const eventId = await insertEvent('Concert A', '30 days');
  const zoneId = await insertZone(eventId, 'VIP', { capacity: 2 });
  const slow = await signUp('slow');
  const next = await signUp('next');

  const first = randomUUID();
  await request(app).post('/bookings').set(slow).send({ eventId, zoneId, quantity: 2, requestId: first }).expect(202);
  await runWorker();

  // Hold runs out.
  await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [first]);
  expect((await request(app).get(`/bookings/${first}`).set(slow)).body.status).toBe('EXPIRED');
  await request(app).post(`/bookings/${first}/pay`).set(slow).expect(409);

  await expireAll();

  const second = randomUUID();
  await request(app).post('/bookings').set(next).send({ eventId, zoneId, quantity: 2, requestId: second }).expect(202);
  await runWorker();
  expect((await request(app).get(`/bookings/${second}`).set(next)).body.status).toBe('PENDING');
});

test('a user cannot see or pay for another user\'s booking', async () => {
  const eventId = await insertEvent('Concert A', '30 days');
  const zoneId = await insertZone(eventId, 'GA', { capacity: 10 });
  const owner = await signUp('owner');
  const other = await signUp('other');

  const requestId = randomUUID();
  await request(app).post('/bookings').set(owner).send({ eventId, zoneId, quantity: 1, requestId }).expect(202);
  await runWorker();

  expect((await request(app).get(`/bookings/${requestId}`).set(other)).body).toEqual({
    bookingId: requestId,
    status: 'QUEUED',
  });
  await request(app).post(`/bookings/${requestId}/pay`).set(other).expect(409);
  expect((await request(app).get('/me/bookings').set(other)).body).toEqual([]);
  expect((await request(app).get(`/bookings/${requestId}`).set(owner)).body.status).toBe('PENDING');
});
