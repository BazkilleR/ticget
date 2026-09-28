// Cleanup job: release expired PENDING holds in every zone and clear the affected events' zone caches.
// Correctness never depends on this (rule 6): the worker releases a zone's expired holds before every
// reservation, and every read treats expired PENDING as not held. This only tidies up zones nobody is
// booking right now. Run it every ~15 minutes (locally: `npm run expire`; on AWS: EventBridge Scheduler).
const logger = require('../logger');
const { pool } = require('../db');
const { redis } = require('../redis');
const cache = require('../services/cache');
const { releaseExpired } = require('../services/booking');

async function expireAll() {
  // Uses the partial index bookings_zone_pending_idx, so this stays cheap however many bookings exist.
  const { rows: zones } = await pool.query(
    `SELECT DISTINCT zone_id AS "zoneId", event_id AS "eventId"
       FROM bookings
      WHERE status = 'PENDING' AND expires_at < now()`,
  );

  const summary = { zones: 0, tickets: 0, failedZones: 0 };
  const affectedEvents = new Set();

  // One short transaction per zone, running the same statement the worker uses, so the job never holds
  // locks across many zones and takes them in the same order as the worker.
  for (const { zoneId, eventId } of zones) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const released = await releaseExpired(client, zoneId);
      await client.query('COMMIT');
      if (released > 0) {
        summary.zones += 1;
        summary.tickets += released;
        affectedEvents.add(eventId);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // e.g. a deadlock with a worker. Harmless: the worker releases these itself, and the next run retries.
      summary.failedZones += 1;
      logger.warn({ err, zoneId }, 'expire: zone failed, will retry next run');
    } finally {
      client.release();
    }
  }

  if (affectedEvents.size > 0) {
    await cache.del(...[...affectedEvents].map(cache.keys.eventZones));
  }
  return summary;
}

async function main() {
  let exitCode = 0;
  try {
    const summary = await expireAll();
    logger.info(summary, 'expire: done');
    if (summary.failedZones > 0) exitCode = 1;
  } catch (err) {
    logger.error({ err }, 'expire: failed');
    exitCode = 1;
  }
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = { expireAll };
