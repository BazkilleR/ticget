// Sales dashboard and reports for admins. Only reachable through routes/admin (requireAuth + requireAdmin).
// Every number here aggregates all users' bookings, the deliberate exception to rule 2 (see CLAUDE.md).
//
// Counting rules, used by every query:
// - sold / revenue: CONFIRMED only, at the price stored on the booking (unit_price), not today's zone price
// - held:           PENDING whose hold has not run out (rule 6)
// - expired:        EXPIRED, plus PENDING past its hold that nobody has released yet
const { pool } = require('../db');
const { HttpError } = require('../middleware/error');

const TIME_ZONE = 'Asia/Bangkok';
const DASHBOARD_DAYS = 14;
const EVENT_DAYS_MAX = 60;

const LIVE_HOLD = `b.status = 'PENDING' AND b.expires_at > now()`;
const SOLD = `b.status = 'CONFIRMED'`;
// Bangkok calendar day of a timestamp.
const bangkokDay = (column) => `(${column} AT TIME ZONE '${TIME_ZONE}')::date`;

// pg returns SUM over bigint as a string; revenue fits a JS number by a wide margin.
const toNumber = (value) => Number(value ?? 0);

// One row per Bangkok day for the last `days` days up to today, zero-filled, so charts have no gaps.
async function dailySales({ days, eventId = null }) {
  const { rows } = await pool.query(
    `WITH days AS (
       SELECT generate_series((now() AT TIME ZONE '${TIME_ZONE}')::date - ($1::int - 1),
                              (now() AT TIME ZONE '${TIME_ZONE}')::date,
                              interval '1 day')::date AS day
     )
     SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(b.quantity), 0)::int AS tickets,
            COALESCE(SUM(b.quantity * b.unit_price), 0)::bigint AS revenue
       FROM days d
       LEFT JOIN bookings b
         ON ${SOLD} AND ${bangkokDay('b.paid_at')} = d.day AND ($2::int IS NULL OR b.event_id = $2)
      GROUP BY d.day
      ORDER BY d.day`,
    [days, eventId],
  );
  return rows.map((r) => ({ ...r, revenue: toNumber(r.revenue) }));
}

async function dashboard() {
  const [totals, upcoming, top, recent, daily] = await Promise.all([
    pool.query(
      `SELECT COALESCE(SUM(b.quantity * b.unit_price) FILTER (WHERE ${SOLD}), 0)::bigint AS revenue,
              COALESCE(SUM(b.quantity) FILTER (WHERE ${SOLD}), 0)::int AS "ticketsSold",
              COALESCE(SUM(b.quantity) FILTER (WHERE ${LIVE_HOLD}), 0)::int AS "ticketsHeld",
              COUNT(*) FILTER (WHERE ${LIVE_HOLD})::int AS pending,
              COUNT(*) FILTER (WHERE ${SOLD})::int AS confirmed,
              COUNT(*) FILTER (WHERE b.status = 'EXPIRED' OR (b.status = 'PENDING' AND b.expires_at <= now()))::int AS expired,
              COUNT(*) FILTER (WHERE b.status = 'FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE b.fail_reason = 'SOLD_OUT')::int AS "soldOut",
              COUNT(*) FILTER (WHERE b.fail_reason = 'USER_LIMIT')::int AS "userLimit"
         FROM bookings b`,
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM events WHERE starts_at > now()`),
    pool.query(
      `SELECT e.id AS "eventId", e.name, e.starts_at AS "startsAt",
              COALESCE(SUM(b.quantity * b.unit_price), 0)::bigint AS revenue,
              COALESCE(SUM(b.quantity), 0)::int AS "ticketsSold",
              (SELECT COALESCE(SUM(z.capacity), 0)::int FROM zones z WHERE z.event_id = e.id) AS capacity
         FROM events e
         JOIN bookings b ON b.event_id = e.id AND ${SOLD}
        GROUP BY e.id
        ORDER BY revenue DESC, "ticketsSold" DESC, e.starts_at
        LIMIT 5`,
    ),
    pool.query(
      `SELECT b.id AS "bookingId", b.paid_at AS "paidAt", u.username,
              e.name AS "eventName", z.name AS "zoneName",
              b.quantity, b.quantity * b.unit_price AS total
         FROM bookings b
         JOIN users u  ON u.id = b.user_id
         JOIN events e ON e.id = b.event_id
         JOIN zones z  ON z.id = b.zone_id
        WHERE ${SOLD}
        ORDER BY b.paid_at DESC, b.id
        LIMIT 10`,
    ),
    dailySales({ days: DASHBOARD_DAYS }),
  ]);

  const t = totals.rows[0];
  return {
    revenue: toNumber(t.revenue),
    ticketsSold: t.ticketsSold,
    ticketsHeld: t.ticketsHeld,
    upcomingEvents: upcoming.rows[0].n,
    bookingsByStatus: { PENDING: t.pending, CONFIRMED: t.confirmed, EXPIRED: t.expired, FAILED: t.failed },
    failReasons: { SOLD_OUT: t.soldOut, USER_LIMIT: t.userLimit },
    topEvents: top.rows.map((r) => ({ ...r, revenue: toNumber(r.revenue) })),
    recentSales: recent.rows,
    daily,
  };
}

// Per-zone sales of one event and its sales per day since the first sale (at most EVENT_DAYS_MAX days).
async function eventSales(eventId) {
  const event = await pool.query(
    `SELECT id, name, venue, starts_at AS "startsAt", sale_opens_at AS "saleOpensAt" FROM events WHERE id = $1`,
    [eventId],
  );
  if (!event.rows[0]) throw new HttpError(404, 'event_not_found', 'Event not found');

  const zones = await pool.query(
    `SELECT z.id AS "zoneId", z.name, z.price, z.capacity,
            COALESCE(SUM(b.quantity) FILTER (WHERE ${SOLD}), 0)::int AS sold,
            COALESCE(SUM(b.quantity) FILTER (WHERE ${LIVE_HOLD}), 0)::int AS held,
            COALESCE(SUM(b.quantity * b.unit_price) FILTER (WHERE ${SOLD}), 0)::bigint AS revenue
       FROM zones z
       LEFT JOIN bookings b ON b.zone_id = z.id
      WHERE z.event_id = $1
      GROUP BY z.id
      ORDER BY z.id`,
    [eventId],
  );

  const firstSale = await pool.query(
    `SELECT (now() AT TIME ZONE '${TIME_ZONE}')::date - MIN(${bangkokDay('b.paid_at')}) + 1 AS days
       FROM bookings b WHERE b.event_id = $1 AND ${SOLD}`,
    [eventId],
  );
  const days = Math.min(Math.max(firstSale.rows[0].days ?? 1, 7), EVENT_DAYS_MAX);

  const zoneRows = zones.rows.map((z) => ({
    ...z,
    revenue: toNumber(z.revenue),
    available: z.capacity - z.sold - z.held,
    sellThrough: z.capacity ? z.sold / z.capacity : 0,
  }));
  const totals = zoneRows.reduce(
    (sum, z) => ({
      capacity: sum.capacity + z.capacity,
      sold: sum.sold + z.sold,
      held: sum.held + z.held,
      revenue: sum.revenue + z.revenue,
    }),
    { capacity: 0, sold: 0, held: 0, revenue: 0 },
  );

  return {
    event: event.rows[0],
    totals: { ...totals, sellThrough: totals.capacity ? totals.sold / totals.capacity : 0 },
    zones: zoneRows,
    daily: await dailySales({ days, eventId }),
  };
}

// ---- CSV report ----------------------------------------------------------------------------------------

const CSV_COLUMNS = ['booking_id', 'paid_at', 'event', 'zone', 'username', 'quantity', 'unit_price', 'total'];

// Quotes fields that need it, and defuses values a spreadsheet would run as a formula (CSV injection):
// event names and usernames come from people, so "=HYPERLINK(...)" must stay text.
function csvField(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Confirmed bookings, oldest payment first. from/to are inclusive Bangkok calendar days of the payment.
async function salesCsv({ from, to, eventId }) {
  const { rows } = await pool.query(
    `SELECT b.id, to_char(b.paid_at AT TIME ZONE '${TIME_ZONE}', 'YYYY-MM-DD HH24:MI') AS paid_at,
            e.name AS event, z.name AS zone, u.username, b.quantity, b.unit_price,
            b.quantity * b.unit_price AS total
       FROM bookings b
       JOIN users u  ON u.id = b.user_id
       JOIN events e ON e.id = b.event_id
       JOIN zones z  ON z.id = b.zone_id
      WHERE ${SOLD}
        AND ($1::date IS NULL OR ${bangkokDay('b.paid_at')} >= $1::date)
        AND ($2::date IS NULL OR ${bangkokDay('b.paid_at')} <= $2::date)
        AND ($3::int IS NULL OR b.event_id = $3)
      ORDER BY b.paid_at, b.id`,
    [from ?? null, to ?? null, eventId ?? null],
  );

  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([r.id, r.paid_at, r.event, r.zone, r.username, r.quantity, r.unit_price, r.total].map(csvField).join(','));
  }
  // The BOM makes Excel read the file as UTF-8, so Thai text is not garbled.
  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { dashboard, eventSales, salesCsv, csvField };
