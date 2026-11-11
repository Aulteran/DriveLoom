-- 0003 accounts (milestone 1.2, auth lane). Owns every table the auth module
-- needs; later auth tables are added to this same file until it merges, so
-- the vehicles lane starts at 0004 and may reference users(id).
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  email_verified_at timestamptz,
  instance_role text NOT NULL DEFAULT 'user' CHECK (instance_role IN ('admin', 'user')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalised CHECK (email = lower(btrim(email)))
);
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE status <> 'deleted';
