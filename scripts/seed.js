// Loads seeds/seed.sql, then creates the admin account from ADMIN_USERNAME / ADMIN_PASSWORD.
// seed.sql truncates every table, so this refuses to run in production.
const fs = require('fs/promises');
const path = require('path');
const config = require('../src/config');
const { pool } = require('../src/db');
const logger = require('../src/logger');
const { registerSchema } = require('../src/routes/auth');
const authService = require('../src/services/auth');

async function loadSeedSql() {
  const sql = await fs.readFile(path.join(__dirname, '..', 'seeds', 'seed.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// The password only ever comes from the environment and is never logged. Without one the admin
// account is skipped rather than failing the whole seed.
async function seedAdmin(env = process.env) {
  if (!env.ADMIN_PASSWORD) {
    logger.warn('seed: ADMIN_PASSWORD not set, skipping admin account');
    return null;
  }
  const parsed = registerSchema.safeParse({
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_PASSWORD,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `ADMIN_${String(i.path[0]).toUpperCase()}: ${i.message}`);
    throw new Error(`invalid admin account: ${problems.join('; ')}`);
  }
  const admin = await authService.upsertAdmin(parsed.data.username, parsed.data.password);
  logger.info({ username: admin.username }, 'seed: admin account ready');
  return admin;
}

async function seed() {
  if (config.nodeEnv === 'production') {
    throw new Error('refusing to seed: NODE_ENV=production');
  }
  await loadSeedSql();
  await seedAdmin();
  logger.info('seed: done');
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch(async (err) => {
      logger.error({ err }, 'seed: failed');
      await pool.end();
      process.exit(1);
    });
}

module.exports = { seedAdmin };
