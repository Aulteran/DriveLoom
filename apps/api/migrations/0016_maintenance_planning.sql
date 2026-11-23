-- 0016 maintenance planning. A task is something the owner wants to keep track
-- of for one vehicle (an oil change every 12 months or 15000 km, a one-off
-- inspection). DriveLoom ships no manufacturer schedules: every interval is
-- typed in by a person. Distances follow fuel and service: *_input and *_unit
-- as entered, *_km normalised. Completion is never inferred: a service item
-- links to a task only when a person chooses it, and deleting the task keeps
-- the item (task_id becomes NULL).
CREATE TABLE maintenance_tasks (
  id uuid PRIMARY KEY,
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  catalog_key text CHECK (catalog_key IS NULL OR char_length(catalog_key) BETWEEN 1 AND 40),
  recurring boolean NOT NULL DEFAULT true,
  interval_days integer CHECK (interval_days BETWEEN 1 AND 36500),
  interval_distance_input numeric CHECK (interval_distance_input > 0),
  interval_distance_unit text CHECK (interval_distance_unit IN ('km', 'mi')),
  interval_distance_km numeric(18, 6),
  first_due_on date,
  first_due_odometer_input numeric CHECK (first_due_odometer_input >= 0),
  first_due_odometer_unit text CHECK (first_due_odometer_unit IN ('km', 'mi')),
  first_due_odometer_km numeric(18, 6),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  archived_at timestamptz,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_tasks_interval_distance_complete CHECK ((interval_distance_input IS NULL) = (interval_distance_unit IS NULL) AND (interval_distance_input IS NULL) = (interval_distance_km IS NULL)),
  CONSTRAINT maintenance_tasks_first_odometer_complete CHECK ((first_due_odometer_input IS NULL) = (first_due_odometer_unit IS NULL) AND (first_due_odometer_input IS NULL) = (first_due_odometer_km IS NULL)),
  CONSTRAINT maintenance_tasks_has_schedule CHECK (interval_days IS NOT NULL OR interval_distance_km IS NOT NULL OR first_due_on IS NOT NULL OR first_due_odometer_km IS NOT NULL),
  -- Recurring tasks repeat by an interval; one-time tasks are due once, at a first-due point.
  CONSTRAINT maintenance_tasks_shape CHECK (
    (recurring AND (interval_days IS NOT NULL OR interval_distance_km IS NOT NULL))
    OR (NOT recurring AND interval_days IS NULL AND interval_distance_km IS NULL AND (first_due_on IS NOT NULL OR first_due_odometer_km IS NOT NULL)))
);
CREATE INDEX maintenance_tasks_vehicle_idx ON maintenance_tasks (vehicle_id, created_at, id);

ALTER TABLE service_items ADD COLUMN task_id uuid REFERENCES maintenance_tasks (id) ON DELETE SET NULL;
CREATE INDEX service_items_task_idx ON service_items (task_id) WHERE task_id IS NOT NULL;

-- Snoozing mutes reminders only; it never reschedules or completes a task.
-- One active row per task and scope: vehicle-wide (user_id NULL) or personal.
-- It ends when its date has passed or the known odometer exceeds its target,
-- whichever happens first.
CREATE TABLE task_snoozes (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES maintenance_tasks (id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('personal', 'vehicle')),
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  snooze_until_date date,
  snooze_until_odometer_km numeric(18, 6),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_snoozes_scope_user CHECK ((scope = 'personal') = (user_id IS NOT NULL)),
  CONSTRAINT task_snoozes_has_end CHECK (snooze_until_date IS NOT NULL OR snooze_until_odometer_km IS NOT NULL)
);
CREATE UNIQUE INDEX task_snoozes_personal_idx ON task_snoozes (task_id, user_id) WHERE scope = 'personal';
CREATE UNIQUE INDEX task_snoozes_vehicle_idx ON task_snoozes (task_id) WHERE scope = 'vehicle';
