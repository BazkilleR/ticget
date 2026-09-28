// Brings the test database schema up to date once per `npm test` run.
module.exports = async () => {
  require('./setup-env');
  const { migrate } = require('../scripts/migrate');
  const { pool } = require('../src/db');
  try {
    await migrate();
  } finally {
    await pool.end();
  }
};
