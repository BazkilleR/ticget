-- Admins manage events and see sales. Checked against the DB on every admin request (requireAdmin),
-- never trusted from the JWT, so revoking a role takes effect immediately.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));
