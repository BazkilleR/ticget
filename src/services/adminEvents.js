// Event and zone management for admins. Only reachable through routes/admin (requireAuth + requireAdmin).
// Reads here aggregate every user's bookings, the deliberate exception to rule 2 (see CLAUDE.md).
const { pool } = require('../db');
const { HttpError } = require('../middleware/error');
const cache = require('./cache');
const { releaseExpired } = require('./booking');

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';

// API field -> events column. Only these can be set by create/update.
const EVENT_COLUMNS = {
  name: 'name',
  venue: 'venue',
  description: 'description',
  startsAt: 'starts_at',
  saleOpensAt: 'sale_opens_at',
};
const ZONE_COLUMNS = { name: 'name', price: 'price', capacity: 'capacity' };

// Per-zone booking counts. Only CONFIRMED is sold and only PENDING that has not expired is held (rule 6);
// "expired" is PENDING past its hold that nobody has released yet, so it still sits in zones.reserved.
const ZONE_STATS = `LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(b.quantity) FILTER (WHERE b.status = 'CONFIRMED'), 0)::int AS sold,
           COALESCE(SUM(b.quantity) FILTER (WHERE b.status = 'PENDING' AND b.expires_at > now()), 0)::int AS held,
           COALESCE(SUM(b.quantity) FILTER (WHERE b.status = 'PENDING' AND b.expires_at <= now()), 0)::int AS expired,
           COUNT(*)::int AS bookings
      FROM bookings b
     WHERE b.zone_id = z.id
  ) s ON true`;

const ZONE_FIELDS = `z.id AS "zoneId", z.name, z.price, z.capacity, z.reserved,
       z.capacity - z.reserved + s.expired AS available,
       s.sold, s.held, s.bookings AS "bookingCount"`;

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Turns constraint violations into the API's error codes; anything else is rethrown as is.
function mapDbError(err) {
  if (err.code === PG_UNIQUE_VIOLATION && err.constraint === 'zones_event_id_name_key') {
    return new HttpError(409, 'zone_name_taken', 'This event already has a zone with that name');
  }
  if (err.code === PG_CHECK_VIOLATION && err.constraint === 'events_schedule_chk') {
    return new HttpError(400, 'invalid_schedule', 'saleOpensAt must not be after startsAt');
  }
  if (err.code === PG_CHECK_VIOLATION && err.constraint === 'zones_check') {
    return new HttpError(409, 'capacity_below_reserved', 'Capacity cannot be lower than seats already reserved');
  }
  return err;
}

// Builds "col = $n" pairs for the fields present in `patch`, appending their values to `params`.
function setClause(patch, columns, params) {
  return Object.keys(columns)
    .filter((key) => patch[key] !== undefined)
    .map((key) => {
      params.push(patch[key]);
      return `${columns[key]} = $${params.length}`;
    })
    .join(', ');
}

// Any event or zone change can show up in the cached public list (minPrice), event page and zone list.
async function invalidateEvent(eventId) {
  await cache.del(cache.keys.eventsList, cache.keys.event(eventId), cache.keys.eventZones(eventId));
}

// ---- events --------------------------------------------------------------------------------------------

async function listEvents({ includePast = false } = {}) {
  const { rows } = await pool.query(
    `SELECT e.id, e.name, e.venue, e.starts_at AS "startsAt", e.sale_opens_at AS "saleOpensAt",
            COUNT(z.id)::int AS "zoneCount",
            COALESCE(SUM(z.capacity), 0)::int AS capacity,
            COALESCE(SUM(s.sold), 0)::int AS sold,
            COALESCE(SUM(s.held), 0)::int AS held,
            COALESCE(SUM(s.bookings), 0)::int AS "bookingCount"
       FROM events e
       LEFT JOIN zones z ON z.event_id = e.id
       ${ZONE_STATS}
      WHERE $1 OR e.starts_at > now()
      GROUP BY e.id
      ORDER BY e.starts_at, e.id`,
    [includePast],
  );
  return rows;
}

async function getEvent(eventId, db = pool) {
  const { rows } = await db.query(
    `SELECT id, name, venue, description, starts_at AS "startsAt", sale_opens_at AS "saleOpensAt"
       FROM events WHERE id = $1`,
    [eventId],
  );
  if (!rows[0]) throw new HttpError(404, 'event_not_found', 'Event not found');

  const zones = await db.query(
    `SELECT ${ZONE_FIELDS}
       FROM zones z
       ${ZONE_STATS}
      WHERE z.event_id = $1
      ORDER BY z.id`,
    [eventId],
  );
  return { ...rows[0], zones: zones.rows };
}

// Creates the event and all its zones in one transaction: either everything exists or nothing does.
async function createEvent({ zones, ...fields }) {
  const params = [];
  const columns = Object.keys(EVENT_COLUMNS).filter((key) => fields[key] !== undefined);
  const placeholders = columns.map((key) => {
    params.push(fields[key]);
    return `$${params.length}`;
  });

  let event;
  try {
    event = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO events (${columns.map((key) => EVENT_COLUMNS[key]).join(', ')})
         VALUES (${placeholders.join(', ')}) RETURNING id`,
        params,
      );
      const eventId = rows[0].id;
      await client.query(
        `INSERT INTO zones (event_id, name, price, capacity)
         SELECT $1, name, price, capacity
           FROM unnest($2::text[], $3::int[], $4::int[]) WITH ORDINALITY AS z(name, price, capacity, n)
          ORDER BY n`,
        [eventId, zones.map((z) => z.name), zones.map((z) => z.price), zones.map((z) => z.capacity)],
      );
      return getEvent(eventId, client);
    });
  } catch (err) {
    throw mapDbError(err);
  }
  await invalidateEvent(event.id);
  return event;
}

async function updateEvent(eventId, patch) {
  const params = [];
  const set = setClause(patch, EVENT_COLUMNS, params);
  params.push(eventId);
  try {
    const { rowCount } = await pool.query(`UPDATE events SET ${set} WHERE id = $${params.length}`, params);
    if (rowCount === 0) throw new HttpError(404, 'event_not_found', 'Event not found');
  } catch (err) {
    throw mapDbError(err);
  }
  await invalidateEvent(eventId);
  return getEvent(eventId);
}

// Only an event nobody has ever booked can be deleted. The bookings foreign keys enforce that, including
// for a booking the worker commits while this runs, so there is no check-then-delete race.
async function deleteEvent(eventId) {
  try {
    await withTransaction(async (client) => {
      await client.query('DELETE FROM zones WHERE event_id = $1', [eventId]);
      const { rowCount } = await client.query('DELETE FROM events WHERE id = $1', [eventId]);
      if (rowCount === 0) throw new HttpError(404, 'event_not_found', 'Event not found');
    });
  } catch (err) {
    if (err.code === PG_FOREIGN_KEY_VIOLATION) {
      throw new HttpError(409, 'event_has_bookings', 'Events with bookings cannot be deleted');
    }
    throw err;
  }
  await invalidateEvent(eventId);
}

// ---- zones ---------------------------------------------------------------------------------------------

async function getZone(zoneId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${ZONE_FIELDS}, z.event_id AS "eventId"
       FROM zones z
       ${ZONE_STATS}
      WHERE z.id = $1`,
    [zoneId],
  );
  return rows[0];
}

async function addZone(eventId, { name, price, capacity }) {
  let zoneId;
  try {
    const { rows } = await pool.query(
      'INSERT INTO zones (event_id, name, price, capacity) VALUES ($1, $2, $3, $4) RETURNING id',
      [eventId, name, price, capacity],
    );
    zoneId = rows[0].id;
  } catch (err) {
    if (err.code === PG_FOREIGN_KEY_VIOLATION) throw new HttpError(404, 'event_not_found', 'Event not found');
    throw mapDbError(err);
  }
  await invalidateEvent(eventId);
  return getZone(zoneId);
}

// Capacity can go down, but never below the seats already reserved: that would mean selling more than
// the zone holds. Expired holds are released first so they do not block the change, then the zone row is
// locked so no booking can slip in between the check and the update. CHECK (reserved <= capacity) backs
// this up in the database.
async function updateZone(zoneId, patch) {
  let zone;
  try {
    zone = await withTransaction(async (client) => {
      await releaseExpired(client, zoneId);
      const { rows } = await client.query('SELECT reserved FROM zones WHERE id = $1 FOR UPDATE', [zoneId]);
      if (!rows[0]) throw new HttpError(404, 'zone_not_found', 'Zone not found');

      const { reserved } = rows[0];
      if (patch.capacity !== undefined && patch.capacity < reserved) {
        throw new HttpError(
          409,
          'capacity_below_reserved',
          `${reserved} seats are already reserved, so capacity must be at least ${reserved}`,
        );
      }

      const params = [];
      const set = setClause(patch, ZONE_COLUMNS, params);
      params.push(zoneId);
      await client.query(`UPDATE zones SET ${set} WHERE id = $${params.length}`, params);
      return getZone(zoneId, client);
    });
  } catch (err) {
    throw mapDbError(err);
  }
  await invalidateEvent(zone.eventId);
  return zone;
}

// Same rule as deleteEvent: the bookings foreign key refuses to drop a zone anyone has booked.
async function deleteZone(zoneId) {
  let eventId;
  try {
    const { rows } = await pool.query('DELETE FROM zones WHERE id = $1 RETURNING event_id', [zoneId]);
    if (!rows[0]) throw new HttpError(404, 'zone_not_found', 'Zone not found');
    eventId = rows[0].event_id;
  } catch (err) {
    if (err.code === PG_FOREIGN_KEY_VIOLATION) {
      throw new HttpError(409, 'zone_has_bookings', 'Zones with bookings cannot be deleted');
    }
    throw err;
  }
  await invalidateEvent(eventId);
}

module.exports = {
  listEvents,
  getEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  addZone,
  updateZone,
  deleteZone,
};
