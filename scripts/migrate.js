// Applies migrations/*.sql in filename order. Each file runs in its own transaction and is
// recorded in schema_migrations, so re-running only applies new files.
const fs = require('fs/promises');
const path = require('path');
const { pool } = require('../src/db');
const logger = require('../src/logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
// Arbitrary constant; keeps two instances (e.g. several EC2 boots) from migrating at once.
const LOCK_KEY = 7_234_001;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      logger.info('migrate: nothing to apply');
      return;
    }

    for (const file of pending) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ migration: file }, 'migrate: applied');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
}

migrate()
  .then(() => pool.end())
  .catch(async (err) => {
    logger.error({ err }, 'migrate: failed');
    await pool.end();
    process.exit(1);
  });
