const { redis } = require('../redis');
const logger = require('../logger');

// Redis is a cache only: every failure here is logged and swallowed so callers fall back to the DB.

const keys = {
  eventsList: 'events:list',
  event: (eventId) => `event:${eventId}`,
  eventZones: (eventId) => `event:${eventId}:zones`,
};

// Cache-aside: return the cached JSON value, or call loader(), cache its result for ttlSeconds and return it.
// null/undefined results are not cached (e.g. "not found"), so they never mask data created later.
async function getOrSet(key, ttlSeconds, loader) {
  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit);
  } catch (err) {
    logger.warn({ err: err.message, key }, 'cache read failed, reading from db');
  }

  const value = await loader();

  if (value !== null && value !== undefined) {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.warn({ err: err.message, key }, 'cache write failed');
    }
  }
  return value;
}

async function del(...cacheKeys) {
  try {
    await redis.del(...cacheKeys);
  } catch (err) {
    logger.warn({ err: err.message, keys: cacheKeys }, 'cache delete failed');
  }
}

module.exports = { keys, getOrSet, del };
