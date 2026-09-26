const config = require('./config');
const logger = require('./logger');
const { createApp } = require('./app');
const { pool } = require('./db');
const { redis } = require('./redis');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'api listening');
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'api shutting down');

  // Stop accepting new connections and let in-flight requests finish.
  server.close(async () => {
    await Promise.allSettled([pool.end(), redis.quit()]);
    logger.info('api stopped');
    process.exit(0);
  });

  // Hard stop if something hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
