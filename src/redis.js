const Redis = require('ioredis');
const config = require('./config');
const logger = require('./logger');

// Redis is a cache only. Commands must fail fast when it is down so callers can fall back to the DB,
// instead of queueing forever while ioredis reconnects.
const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 2000,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});

let lastErrorLoggedAt = 0;
redis.on('error', (err) => {
  // Reconnect loops emit an error every attempt; throttle to one warning per 30s.
  const now = Date.now();
  if (now - lastErrorLoggedAt > 30_000) {
    lastErrorLoggedAt = now;
    logger.warn({ err: err.message }, 'redis unavailable');
  }
});

async function ping() {
  const res = await redis.ping();
  if (res !== 'PONG') throw new Error(`unexpected redis ping reply: ${res}`);
}

module.exports = { redis, ping };
