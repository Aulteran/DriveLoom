-- 0018 maintenance presets: the schema foundation for advisory templates that a
-- person may choose to import (bundled in the repository, never fetched). A
-- preset only fills in ordinary task columns; nothing here is a manufacturer
-- rule that DriveLoom enforces. Rules: src/service/maintenance-status.ts.

-- A time interval may be counted in calendar months (end-of-month clamped) as
-- well as in days, but never both on one task.
ALTER TABLE maintenance_tasks
  ADD COLUMN interval_months integer CHECK (interval_months BETWEEN 1 AND 1200),
  -- Where the task came from. All three set for a task imported from a preset, else all NULL.
  ADD COLUMN preset_id text CHECK (preset_id IS NULL OR char_length(preset_id) BETWEEN 1 AND 100),
  ADD COLUMN preset_version integer CHECK (preset_version IS NULL OR preset_version >= 1),
  ADD COLUMN preset_task_id text CHECK (preset_task_id IS NULL OR char_length(preset_task_id) BETWEEN 1 AND 100),
  -- The task's own starting point when no linked service item exists yet.
  -- `reported`: the owner states when (and/or at what odometer) it was last done
  -- without a record; it counts like a completion for scheduling only.
  -- `tracking`: "start tracking now"; a reference point, never shown as done or up to date.
  ADD COLUMN baseline_kind text CHECK (baseline_kind IN ('reported', 'tracking')),
  ADD COLUMN baseline_on date,
  ADD COLUMN baseline_odometer_input numeric CHECK (baseline_odometer_input >= 0),
  ADD COLUMN baseline_odometer_unit text CHECK (baseline_odometer_unit IN ('km', 'mi')),
  ADD COLUMN baseline_odometer_km numeric(18, 6),
  -- Per-task email reminders, on top of the vehicle's switch. Typed-in tasks keep
  -- them on; imported preset tasks start with them off until the owner opts in.
  ADD COLUMN reminders_enabled boolean NOT NULL DEFAULT true,
  -- Provenance label for the interval, shown to people as such.
  ADD COLUMN source_trust text CHECK (source_trust IN ('manufacturer', 'community')),
  ADD COLUMN source_note text CHECK (source_note IS NULL OR char_length(source_note) BETWEEN 1 AND 300);

ALTER TABLE maintenance_tasks
  ADD CONSTRAINT maintenance_tasks_single_time_unit CHECK (interval_days IS NULL OR interval_months IS NULL),
  ADD CONSTRAINT maintenance_tasks_preset_complete CHECK ((preset_id IS NULL) = (preset_version IS NULL) AND (preset_id IS NULL) = (preset_task_id IS NULL)),
  ADD CONSTRAINT maintenance_tasks_baseline_odometer_complete CHECK ((baseline_odometer_input IS NULL) = (baseline_odometer_unit IS NULL) AND (baseline_odometer_input IS NULL) = (baseline_odometer_km IS NULL)),
  ADD CONSTRAINT maintenance_tasks_baseline_shape CHECK (
    (baseline_kind IS NULL AND baseline_on IS NULL AND baseline_odometer_km IS NULL)
    OR (baseline_kind IS NOT NULL AND (baseline_on IS NOT NULL OR baseline_odometer_km IS NOT NULL)));

ALTER TABLE maintenance_tasks DROP CONSTRAINT maintenance_tasks_has_schedule, DROP CONSTRAINT maintenance_tasks_shape;
ALTER TABLE maintenance_tasks
  ADD CONSTRAINT maintenance_tasks_has_schedule CHECK (interval_days IS NOT NULL OR interval_months IS NOT NULL OR interval_distance_km IS NOT NULL OR first_due_on IS NOT NULL OR first_due_odometer_km IS NOT NULL),
  -- Recurring tasks repeat by an interval; one-time tasks are due once, at a first-due point, and have no baseline.
  ADD CONSTRAINT maintenance_tasks_shape CHECK (
    (recurring AND (interval_days IS NOT NULL OR interval_months IS NOT NULL OR interval_distance_km IS NOT NULL))
    OR (NOT recurring AND interval_days IS NULL AND interval_months IS NULL AND interval_distance_km IS NULL AND baseline_kind IS NULL
        AND (first_due_on IS NOT NULL OR first_due_odometer_km IS NOT NULL)));

-- Re-importing a preset finds the task it made instead of adding another.
CREATE UNIQUE INDEX maintenance_tasks_preset_idx ON maintenance_tasks (vehicle_id, preset_id, preset_task_id) WHERE preset_id IS NOT NULL;
