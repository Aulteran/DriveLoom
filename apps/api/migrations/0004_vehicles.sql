-- 0004 vehicles and ownership (milestone 1.3). References users(id) from 0003.
CREATE TABLE vehicles (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  make text CHECK (make IS NULL OR char_length(make) BETWEEN 1 AND 80),
  model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 80),
  model_year integer CHECK (model_year IS NULL OR model_year BETWEEN 1886 AND 2200),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicle_members (
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  granted_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, user_id)
);
-- Invariant: exactly one owner per vehicle. At most one is enforced here; the
-- service creates the owner row in the same transaction as the vehicle and
-- never removes it without replacing it.
CREATE UNIQUE INDEX vehicle_members_one_owner ON vehicle_members (vehicle_id) WHERE role = 'owner';
CREATE INDEX vehicle_members_user_idx ON vehicle_members (user_id);
