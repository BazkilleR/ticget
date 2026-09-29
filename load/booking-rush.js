// k6 booking rush: every virtual user books 1 ticket in the same zone at the same moment, then polls until
// the worker has decided. With 1,000 users and 100 seats, exactly 100 must end PENDING and 900 SOLD_OUT.
//
//   npm run load:prepare     # creates the event/zone/users, writes load/.data/*.json
//   npm run load:run         # this script (the API and at least one worker must be running)
//   npm run load:verify      # checks the database: no overselling
//
// Options (pass to k6 with -e): BASE_URL (default http://localhost:3000), POLL_TIMEOUT_S (default 90).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const rush = JSON.parse(open('./.data/rush.json'));
// SharedArray: one copy of the tokens for all VUs instead of one per VU.
const tokens = new SharedArray('tokens', () => JSON.parse(open('./.data/tokens.json')));

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const POLL_TIMEOUT_S = Number(__ENV.POLL_TIMEOUT_S || 90);

const outcomes = {
  PENDING: new Counter('booking_pending'),
  SOLD_OUT: new Counter('booking_sold_out'),
  OTHER: new Counter('booking_other_result'),
  TIMEOUT: new Counter('booking_poll_timeout'),
};
const timeToResult = new Trend('booking_time_to_result', true);

export const options = {
  scenarios: {
    rush: {
      executor: 'per-vu-iterations',
      vus: rush.users,
      iterations: 1,
      maxDuration: '3m',
    },
  },
  thresholds: {
    'http_req_failed{name:POST /bookings}': ['rate<0.01'],
    'checks{check:accepted}': ['rate>0.99'],
    booking_poll_timeout: ['count==0'],
  },
};

function uuidv4() {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function () {
  const headers = {
    Authorization: `Bearer ${tokens[__VU - 1]}`,
    'Content-Type': 'application/json',
  };
  const requestId = uuidv4();
  const started = Date.now();

  const res = http.post(
    `${BASE_URL}/bookings`,
    JSON.stringify({ eventId: rush.eventId, zoneId: rush.zoneId, quantity: 1, requestId }),
    { headers, tags: { name: 'POST /bookings' } },
  );
  if (!check(res, { accepted: (r) => r.status === 202 })) return;

  // Poll until the worker has processed the request.
  while ((Date.now() - started) / 1000 < POLL_TIMEOUT_S) {
    sleep(0.5 + Math.random() * 0.5);
    const poll = http.get(`${BASE_URL}/bookings/${requestId}`, { headers, tags: { name: 'GET /bookings/:id' } });
    if (poll.status !== 200) continue;

    const booking = poll.json();
    if (booking.status === 'QUEUED') continue;

    timeToResult.add(Date.now() - started);
    if (booking.status === 'PENDING') outcomes.PENDING.add(1);
    else if (booking.failReason === 'SOLD_OUT') outcomes.SOLD_OUT.add(1);
    else outcomes.OTHER.add(1);
    return;
  }
  outcomes.TIMEOUT.add(1);
}
