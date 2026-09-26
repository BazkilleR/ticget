CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  venue         TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  sale_opens_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE zones (
  id        SERIAL PRIMARY KEY,
  event_id  INT  NOT NULL REFERENCES events(id),
  name      TEXT NOT NULL,
  price     INT  NOT NULL CHECK (price >= 0),
  capacity  INT  NOT NULL CHECK (capacity > 0),
  -- Counts PENDING (not yet expired) + CONFIRMED tickets.
  reserved  INT  NOT NULL DEFAULT 0,
  -- Last line of defence against overselling: the DB rejects any update past capacity.
  CHECK (reserved >= 0 AND reserved <= capacity),
  UNIQUE (event_id, name)
);

CREATE TABLE bookings (
  id          UUID PRIMARY KEY,               -- same value as request_id
  request_id  UUID UNIQUE NOT NULL,           -- idempotency key from the client
  user_id     UUID NOT NULL REFERENCES users(id),
  event_id    INT  NOT NULL REFERENCES events(id),
  zone_id     INT  NOT NULL REFERENCES zones(id),
  quantity    INT  NOT NULL CHECK (quantity BETWEEN 1 AND 4),
  status      TEXT NOT NULL CHECK (status IN ('PENDING','CONFIRMED','EXPIRED','FAILED')),
  fail_reason TEXT,                           -- e.g. SOLD_OUT, USER_LIMIT
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bookings_zone_pending_idx ON bookings (zone_id, expires_at) WHERE status = 'PENDING';
CREATE INDEX bookings_user_idx ON bookings (user_id, event_id);
