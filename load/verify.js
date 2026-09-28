// Checks the database after a load test. Exits 1 if anything is wrong.
//   1. Load-test zone: tickets held (PENDING + CONFIRMED) == capacity == zones.reserved, i.e. sold out
//      exactly, never oversold. Every user got an answer (a booking row), none left unprocessed.
//   2. Every zone in the database: zones.reserved == SUM(quantity) of its PENDING + CONFIRMED bookings,
//      and no user holds more than MAX_TICKETS_PER_USER in any event.
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { pool } = require('../src/db');
const { redis } = require('../src/redis');

const rush = JSON.parse(fs.readFileSync(path.join(__dirname, '.data', 'rush.json'), 'utf8'));

const results = [];
function expectEqual(name, actual, expected) {
  results.push({ ok: actual === expected, name, actual, expected });
}

async function main() {
  const zone = (await pool.query('SELECT capacity, reserved FROM zones WHERE id = $1', [rush.zoneId])).rows[0];
  if (!zone) throw new Error(`zone ${rush.zoneId} not found; run npm run load:prepare first`);

  const byStatus = (
    await pool.query(
      `SELECT status, COALESCE(fail_reason, '') AS reason, COUNT(*)::int AS bookings, SUM(quantity)::int AS tickets
         FROM bookings WHERE zone_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`,
      [rush.zoneId],
    )
  ).rows;
  const sum = (pred, field) => byStatus.filter(pred).reduce((n, r) => n + r[field], 0);
  const held = sum((r) => r.status === 'PENDING' || r.status === 'CONFIRMED', 'tickets');
  const processed = sum(() => true, 'bookings');
  const soldOut = sum((r) => r.reason === 'SOLD_OUT', 'bookings');
  const expectedHeld = Math.min(rush.users, rush.capacity);

  console.log(`\nLoad-test zone ${rush.zoneId}: capacity ${zone.capacity}, ${rush.users} users x 1 ticket`);
  console.table(byStatus);

  expectEqual('tickets held (PENDING + CONFIRMED) == capacity', held, expectedHeld);
  expectEqual('zones.reserved == capacity', zone.reserved, expectedHeld);
  expectEqual('zones.reserved == tickets held', zone.reserved, held);
  expectEqual('every request processed (one booking row per user)', processed, rush.users);
  expectEqual('everyone else got SOLD_OUT', soldOut, rush.users - expectedHeld);

  const drift = (
    await pool.query(
      `SELECT z.id, z.reserved, COALESCE(SUM(b.quantity), 0)::int AS held
         FROM zones z
         LEFT JOIN bookings b ON b.zone_id = z.id AND b.status IN ('PENDING', 'CONFIRMED')
        GROUP BY z.id HAVING z.reserved <> COALESCE(SUM(b.quantity), 0)`,
    )
  ).rows;
  expectEqual('all zones: reserved == PENDING + CONFIRMED (zones that differ)', drift.length, 0);

  const overLimit = (
    await pool.query(
      `SELECT user_id, event_id, SUM(quantity)::int AS tickets
         FROM bookings
        WHERE status = 'CONFIRMED' OR (status = 'PENDING' AND expires_at > now())
        GROUP BY 1, 2 HAVING SUM(quantity) > $1`,
      [config.maxTicketsPerUser],
    )
  ).rows;
  expectEqual(`no user over ${config.maxTicketsPerUser} tickets per event (users over)`, overLimit.length, 0);

  console.log('');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.actual}${r.ok ? '' : ` (expected ${r.expected})`}`);
  }
  if (drift.length) console.table(drift);
  if (overLimit.length) console.table(overLimit);

  return results.every((r) => r.ok);
}

main()
  .then(async (ok) => {
    await Promise.allSettled([pool.end(), redis.quit()]);
    console.log(ok ? '\nNo overselling.' : '\nVERIFY FAILED');
    process.exit(ok ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(err);
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(1);
  });
