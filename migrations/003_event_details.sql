-- Free-text details shown on the event page (set by admins).
ALTER TABLE events ADD COLUMN description TEXT;

-- A sale that opens after the show has started can never sell anything.
ALTER TABLE events ADD CONSTRAINT events_schedule_chk CHECK (sale_opens_at <= starts_at);

-- Every public listing and search filters and sorts on starts_at.
CREATE INDEX events_starts_at_idx ON events (starts_at);
