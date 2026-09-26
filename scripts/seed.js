// Loads seeds/seed.sql. It truncates every table, so it refuses to run in production.
const fs = require('fs/promises');
const path = require('path');
const config = require('../src/config');
const { pool } = require('../src/db');
const logger = require('../src/logger');

async function seed() {
  if (config.nodeEnv === 'production') {
    throw new Error('refusing to seed: NODE_ENV=production');
  }

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
  logger.info('seed: done');
}

seed()
  .then(() => pool.end())
  .catch(async (err) => {
    logger.error({ err }, 'seed: failed');
    await pool.end();
    process.exit(1);
  });
