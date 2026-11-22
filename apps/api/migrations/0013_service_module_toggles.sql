-- Opt-in feature modules. `instance_modules` is the server-wide switch an
-- administrator controls; a module with no row is disabled, so nothing is
-- seeded and a restore loads the archived rows as they were.
CREATE TABLE instance_modules (
  module text PRIMARY KEY,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A member's personal choice to show or hide the Service page for one vehicle.
-- No row means shown (the default). It only affects menus: it never changes
-- permissions and never deletes data, and it is ignored while the instance
-- module is off.
CREATE TABLE vehicle_user_prefs (
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id),
  show_service boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, user_id)
);
CREATE INDEX vehicle_user_prefs_user_idx ON vehicle_user_prefs (user_id);
