const { pool } = require('../db');
const cache = require('./cache');
const { HttpError } = require('../middleware/error');

const EVENTS_TTL_SECONDS = 60;
const ZONES_TTL_SECONDS = 3;

// Events that have not started yet, soonest first.
async function listUpcoming() {
  return cache.getOrSet(cache.keys.eventsList, EVENTS_TTL_SECONDS, async () => {
    const { rows } = await pool.query(
      `SELECT id, name, venue, starts_at AS "startsAt", sale_opens_at AS "saleOpensAt"
         FROM events
        WHERE starts_at > now()
        ORDER BY starts_at, id`,
    );
    return rows;
  });
}

// Zones of one event with live availability. Throws 404 if the event does not exist.
async function listZones(eventId) {
  const zones = await cache.getOrSet(cache.keys.eventZones(eventId), ZONES_TTL_SECONDS, async () => {
    const event = await pool.query('SELECT 1 FROM events WHERE id = $1', [eventId]);
    if (event.rowCount === 0) return null;

    // zones.reserved may still include PENDING bookings whose hold has expired but that the worker or
    // cleanup job has not released yet. Those must not count as taken, so add them back.
    const { rows } = await pool.query(
      `SELECT z.id AS "zoneId", z.name, z.price,
              z.capacity - z.reserved + COALESCE(x.expired, 0) AS available
         FROM zones z
         LEFT JOIN LATERAL (
           SELECT SUM(b.quantity)::int AS expired
             FROM bookings b
            WHERE b.zone_id = z.id AND b.status = 'PENDING' AND b.expires_at < now()
         ) x ON true
        WHERE z.event_id = $1
        ORDER BY z.id`,
      [eventId],
    );
    return rows;
  });

  if (zones === null) throw new HttpError(404, 'event_not_found', 'Event not found');
  return zones;
}

module.exports = { listUpcoming, listZones };
