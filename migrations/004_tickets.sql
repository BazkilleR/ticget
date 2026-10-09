-- When a booking was paid. Bookings confirmed before this migration get their last update time.
ALTER TABLE bookings ADD COLUMN paid_at TIMESTAMPTZ;
UPDATE bookings SET paid_at = updated_at WHERE status = 'CONFIRMED';

-- One e-ticket per seat, issued in the same statement that confirms the booking (services/booking.js).
-- code is 128 random bits: the QR code carries it, so it must be unguessable. checked_in_at is set once,
-- by a conditional UPDATE, so a ticket can only be used to enter once.
CREATE TABLE tickets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    UUID NOT NULL REFERENCES bookings(id),
  seq           INT  NOT NULL CHECK (seq BETWEEN 1 AND 4),
  code          TEXT UNIQUE NOT NULL,
  checked_in_at TIMESTAMPTZ,
  checked_in_by UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, seq)
);

-- Bookings that were already confirmed get their tickets now.
INSERT INTO tickets (booking_id, seq, code)
SELECT b.id, g, encode(gen_random_bytes(16), 'hex')
  FROM bookings b
 CROSS JOIN LATERAL generate_series(1, b.quantity) AS g
 WHERE b.status = 'CONFIRMED';
