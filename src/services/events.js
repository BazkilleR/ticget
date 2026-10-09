const { pool } = require('../db');
const cache = require('./cache');
const { HttpError } = require('../middleware/error');

const EVENTS_TTL_SECONDS = 60;
const EVENT_TTL_SECONDS = 60;
const ZONES_TTL_SECONDS = 3;
const SEARCH_LIMIT = 50;

// Dates in search filters are Thai calendar days, not UTC ones.
const TIME_ZONE = 'Asia/Bangkok';

// minPrice is the cheapest zone, or null for an event with no zones yet.
const EVENT_FIELDS = `e.id, e.name, e.venue, e.starts_at AS "startsAt", e.sale_opens_at AS "saleOpensAt",
       p.min_price AS "minPrice"`;
const EVENT_FROM = `FROM events e
  LEFT JOIN LATERAL (SELECT MIN(z.price) AS min_price FROM zones z WHERE z.event_id = e.id) p ON true`;

// Events that have not started yet, soonest first.
async function listUpcoming() {
  return cache.getOrSet(cache.keys.eventsList, EVENTS_TTL_SECONDS, async () => {
    const { rows } = await pool.query(
      `SELECT ${EVENT_FIELDS}
         ${EVENT_FROM}
        WHERE e.starts_at > now()
        ORDER BY e.starts_at, e.id`,
    );
    return rows;
  });
}

// So a search for "50%" or "a_b" matches those characters literally instead of as wildcards.
function escapeLike(text) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Upcoming events matching every given filter. Not cached: the combinations are endless and the query
// is cheap. Filters arrive validated (see routes/events.js); every value goes in as a $n parameter.
async function search({ q, from, to, sale, maxPrice, sort = 'date', limit = SEARCH_LIMIT }) {
  const where = ['e.starts_at > now()'];
  const params = [];
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (q !== undefined) {
    const pattern = param(`%${escapeLike(q)}%`);
    where.push(`(e.name ILIKE ${pattern} OR e.venue ILIKE ${pattern})`);
  }
  if (from !== undefined) {
    where.push(`e.starts_at >= (${param(from)}::date)::timestamp AT TIME ZONE '${TIME_ZONE}'`);
  }
  if (to !== undefined) {
    // "to" is inclusive: anything before the start of the next day.
    where.push(`e.starts_at < (${param(to)}::date + 1)::timestamp AT TIME ZONE '${TIME_ZONE}'`);
  }
  if (sale === 'open') where.push('e.sale_opens_at <= now()');
  if (sale === 'upcoming') where.push('e.sale_opens_at > now()');
  if (maxPrice !== undefined) where.push(`p.min_price <= ${param(maxPrice)}`);

  const orderBy = sort === 'price' ? 'p.min_price NULLS LAST, e.starts_at, e.id' : 'e.starts_at, e.id';

  const { rows } = await pool.query(
    `SELECT ${EVENT_FIELDS}
       ${EVENT_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT ${param(limit)}`,
    params,
  );
  return rows;
}

// One event, including ones that already started (old booking links still show it). 404 if missing.
async function getEvent(eventId) {
  const event = await cache.getOrSet(cache.keys.event(eventId), EVENT_TTL_SECONDS, async () => {
    const { rows } = await pool.query(
      `SELECT ${EVENT_FIELDS}, e.description
         ${EVENT_FROM}
        WHERE e.id = $1`,
      [eventId],
    );
    return rows[0] ?? null;
  });

  if (event === null) throw new HttpError(404, 'event_not_found', 'Event not found');
  return event;
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

module.exports = { listUpcoming, search, getEvent, listZones };
