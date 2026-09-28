const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { requireAuth } = require('../src/middleware/auth');
const { errorHandler } = require('../src/middleware/error');
const { resetUsers, closeConnections } = require('./helpers');

const app = createApp();
const creds = { username: 'alice', password: 'correct-horse-battery' };

beforeEach(resetUsers);
afterAll(closeConnections);

describe('POST /auth/register', () => {
  test('creates a user and returns 201 { id, username }', async () => {
    const res = await request(app).post('/auth/register').send(creds);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), username: 'alice' });
  });

  test('stores a bcrypt hash with cost 12, never the plain password', async () => {
    await request(app).post('/auth/register').send(creds);

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE username = $1', ['alice']);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(rows[0].password_hash).not.toContain(creds.password);
  });

  test('duplicate username returns 409', async () => {
    await request(app).post('/auth/register').send(creds).expect(201);
    const res = await request(app).post('/auth/register').send({ ...creds, password: 'another-password' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('username_taken');
  });

  test.each([
    ['missing password', { username: 'bob' }],
    ['short password', { username: 'bob', password: 'short' }],
    ['password over 72 bytes', { username: 'bob', password: 'x'.repeat(73) }],
    ['bad username chars', { username: 'bob smith', password: 'long-enough-pw' }],
    ['short username', { username: 'bo', password: 'long-enough-pw' }],
  ])('rejects %s with 400 validation_error', async (_name, body) => {
    const res = await request(app).post('/auth/register').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  test('malformed JSON returns 400 invalid_json', async () => {
    const res = await request(app)
      .post('/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"username":');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });
});

describe('POST /auth/login', () => {
  let userId;
  beforeEach(async () => {
    const res = await request(app).post('/auth/register').send(creds);
    userId = res.body.id;
  });

  test('returns a 1-hour HS256 JWT with sub = userId', async () => {
    const res = await request(app).post('/auth/login').send(creds);

    expect(res.status).toBe(200);
    const payload = jwt.verify(res.body.token, config.jwtSecret, { algorithms: ['HS256'] });
    expect(payload.sub).toBe(userId);
    expect(payload.exp - payload.iat).toBe(3600);
  });

  test('wrong password and unknown username get the identical 401 response', async () => {
    const wrongPw = await request(app).post('/auth/login').send({ ...creds, password: 'wrong-password' });
    const noUser = await request(app).post('/auth/login').send({ username: 'nobody', password: 'whatever-pw' });

    expect(wrongPw.status).toBe(401);
    expect(wrongPw.body.error).toBe('invalid_credentials');
    expect(noUser.status).toBe(401);
    expect(noUser.body).toEqual(wrongPw.body);
  });
});

describe('requireAuth middleware', () => {
  // No protected routes exist yet, so mount the middleware on a throwaway app.
  const protectedApp = express();
  protectedApp.get('/protected', requireAuth, (req, res) => res.json({ userId: req.userId }));
  protectedApp.use(errorHandler);

  const sign = (claims, opts = {}) =>
    jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256', expiresIn: '1h', ...opts });

  test('no token returns 401', async () => {
    const res = await request(protectedApp).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  test.each([
    ['non-Bearer scheme', () => `Basic ${sign({ sub: 'u1' })}`],
    ['garbage token', () => 'Bearer not-a-jwt'],
    ['wrong secret', () => `Bearer ${jwt.sign({ sub: 'u1' }, 'some-other-secret-value')}`],
    ['expired token', () => `Bearer ${sign({ sub: 'u1' }, { expiresIn: -10 })}`],
    ['alg none', () => `Bearer ${jwt.sign({ sub: 'u1' }, null, { algorithm: 'none' })}`],
    ['missing sub', () => `Bearer ${sign({ foo: 'bar' })}`],
  ])('%s returns 401', async (_name, header) => {
    const res = await request(protectedApp).get('/protected').set('Authorization', header());

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  test('valid token from /auth/login sets req.userId', async () => {
    const reg = await request(app).post('/auth/register').send(creds);
    const login = await request(app).post('/auth/login').send(creds);

    const res = await request(protectedApp)
      .get('/protected')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(reg.body.id);
  });
});
