-- The zone price at the moment of booking, so sales reports do not change when an admin edits a price.
-- Set by the worker for PENDING bookings; FAILED ones never had a price. Existing rows use today's price,
-- the best that can be known after the fact.
ALTER TABLE bookings ADD COLUMN unit_price INT CHECK (unit_price >= 0);
UPDATE bookings b SET unit_price = z.price FROM zones z WHERE b.zone_id = z.id AND b.status <> 'FAILED';

-- Sales reports group by event and filter on status / payment time.
CREATE INDEX bookings_event_status_idx ON bookings (event_id, status);
CREATE INDEX bookings_paid_at_idx ON bookings (paid_at) WHERE status = 'CONFIRMED';
