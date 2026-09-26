const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

pool.on('error', (err) => {
  // Emitted for errors on idle clients; the pool discards the client and keeps going.
  logger.error({ err }, 'postgres idle client error');
});

async function ping() {
  await pool.query('SELECT 1');
}

module.exports = { pool, ping };
