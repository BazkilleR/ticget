const express = require('express');
const request = require('supertest');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { requireAuth } = require('../src/middleware/auth');
const { requireAdmin } = require('../src/middleware/admin');
const { errorHandler } = require('../src/middleware/error');
const { seedAdmin } = require('../scripts/seed');
const { resetUsers, closeConnections, createUser } = require('./helpers');

const app = createApp();

beforeEach(resetUsers);
afterAll(closeConnections);

describe('GET /me', () => {
  test('returns the caller with role user', async () => {
    const { userId, token } = await createUser('alice');

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: userId, username: 'alice', role: 'user' });
  });

  test('returns role admin for an admin', async () => {
    const { token } = await createUser('boss', { role: 'admin' });

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.body.role).toBe('admin');
  });

  test('never exposes the password hash', async () => {
    const { token } = await createUser('alice');

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(JSON.stringify(res.body)).not.toMatch(/hash/i);
  });

  test('no token returns 401', async () => {
    const res = await request(app).get('/me');

    expect(res.status).toBe(401);
  });

  test('a valid token for a deleted user returns 401', async () => {
    const { userId, token } = await createUser('ghost');
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });
});

describe('requireAdmin middleware', () => {
  // Admin routes arrive in a later phase, so mount the middleware on a throwaway app.
  const adminApp = express();
  adminApp.get('/admin-only', requireAuth, requireAdmin, (req, res) => res.json({ ok: true }));
  adminApp.use(errorHandler);

  test('no token returns 401', async () => {
    const res = await request(adminApp).get('/admin-only');

    expect(res.status).toBe(401);
  });

  test('a normal user gets 403 forbidden', async () => {
    const { token } = await createUser('alice');

    const res = await request(adminApp).get('/admin-only').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden', message: expect.any(String) });
  });

  test('an admin passes', async () => {
    const { token } = await createUser('boss', { role: 'admin' });

    const res = await request(adminApp).get('/admin-only').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  test('revoking the role takes effect immediately on the same token', async () => {
    const { userId, token } = await createUser('boss', { role: 'admin' });
    await request(adminApp).get('/admin-only').set('Authorization', `Bearer ${token}`).expect(200);

    await pool.query(`UPDATE users SET role = 'user' WHERE id = $1`, [userId]);

    const res = await request(adminApp).get('/admin-only').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('seedAdmin', () => {
  const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-long-admin-password' };

  test('creates an admin who can log in with the password from env', async () => {
    await seedAdmin(env);

    const login = await request(app).post('/auth/login').send({ username: 'admin', password: env.ADMIN_PASSWORD });
    expect(login.status).toBe(200);

    const me = await request(app).get('/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.body).toMatchObject({ username: 'admin', role: 'admin' });
  });

  test('stores a bcrypt hash with cost 12', async () => {
    await seedAdmin(env);

    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE username = 'admin'`);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
  });

  test('promotes an existing user and resets their password', async () => {
    await createUser('admin');

    await seedAdmin(env);

    const { rows } = await pool.query(`SELECT role FROM users WHERE username = 'admin'`);
    expect(rows).toEqual([{ role: 'admin' }]);
    await request(app)
      .post('/auth/login')
      .send({ username: 'admin', password: env.ADMIN_PASSWORD })
      .expect(200);
  });

  test('skips without ADMIN_PASSWORD', async () => {
    expect(await seedAdmin({})).toBeNull();

    const { rows } = await pool.query('SELECT 1 FROM users');
    expect(rows).toHaveLength(0);
  });

  test('rejects a weak password without echoing it', async () => {
    const weak = 'pw-1234';

    const err = await seedAdmin({ ADMIN_PASSWORD: weak }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ADMIN_PASSWORD/);
    expect(err.message).not.toContain(weak);
  });
});
