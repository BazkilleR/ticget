-- Development/test data. Wipes all tables first so it can be re-run and IDs are always the same:
-- events 1-2, zones 1-6.
TRUNCATE bookings, zones, events, users RESTART IDENTITY CASCADE;

INSERT INTO events (name, venue, starts_at, sale_opens_at) VALUES
  -- Event 1: on sale now.
  ('Concert A', 'Impact Arena',       now() + interval '30 days', now() - interval '1 day'),
  -- Event 2: sale opens in 7 days, for testing that early bookings are rejected.
  ('Concert B', 'Thunder Dome',       now() + interval '60 days', now() + interval '7 days');

INSERT INTO zones (event_id, name, price, capacity) VALUES
  (1, 'VIP',      5000,   5),   -- zone 1: tiny, for sold-out tests
  (1, 'Standard', 2500, 100),   -- zone 2: k6 load test (1,000 users, 100 tickets)
  (1, 'GA',       1500, 500),   -- zone 3
  (2, 'VIP',      6000,  50),   -- zone 4
  (2, 'Standard', 3000, 200),   -- zone 5
  (2, 'GA',       1800, 800);   -- zone 6
