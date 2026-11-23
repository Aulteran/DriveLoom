-- 0017 service notifications: email reminders for maintenance that is due soon
-- or overdue, sent through the administrator's SMTP settings only. Off for every
-- vehicle until its owner or a manager turns it on. Rules: src/service/notifications.ts.

-- Per-vehicle switch and follow-up cadence (days between repeat reminders while
-- a task stays due; 0 = remind once per due point and level).
CREATE TABLE vehicle_notification_settings (
  vehicle_id uuid PRIMARY KEY REFERENCES vehicles (id) ON DELETE CASCADE,
  email_enabled boolean NOT NULL DEFAULT false,
  follow_up_days integer NOT NULL DEFAULT 7 CHECK (follow_up_days BETWEEN 0 AND 90),
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Members an owner or manager picked to receive the emails (managers and drivers;
-- the owner receives them without a row). Tied to the membership: revoking access
-- removes the selection.
CREATE TABLE vehicle_notification_recipients (
  vehicle_id uuid NOT NULL,
  user_id uuid NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  selected_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, user_id),
  FOREIGN KEY (vehicle_id, user_id) REFERENCES vehicle_members (vehicle_id, user_id) ON DELETE CASCADE
);

-- A person's own "do not email me about this vehicle". Always wins over a selection,
-- and is kept if they leave and are added again.
CREATE TABLE vehicle_notification_optouts (
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vehicle_id, user_id)
);

-- What each person was already told about each task: one row per due point
-- (occurrence_key) and level. Durable (it is in backups), so a restore never
-- re-sends what was already sent. `sends` counts reminders queued for that row,
-- `last_bucket` the follow-up period last covered, `muted` that a snooze hid it
-- since (so it comes back once the snooze ends).
CREATE TABLE notification_task_log (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES maintenance_tasks (id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  occurrence_key text NOT NULL CHECK (char_length(occurrence_key) BETWEEN 1 AND 100),
  level text NOT NULL CHECK (level IN ('due_soon', 'overdue')),
  first_notified_at timestamptz NOT NULL,
  last_bucket integer NOT NULL DEFAULT 0,
  sends integer NOT NULL DEFAULT 1,
  muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, task_id, occurrence_key, level)
);
CREATE INDEX notification_task_log_vehicle_idx ON notification_task_log (vehicle_id, user_id);

-- One grouped email per recipient and vehicle. Delivery is at least once:
-- rows are claimed with a lease (FOR UPDATE SKIP LOCKED); a sender that dies
-- mid-send leaves its row to be claimed again once the lease expires.
-- dedupe_key makes enqueueing idempotent across runs and instances.
-- Ephemeral: not in backups (src/backup.ts), so a restored instance never
-- sends another instance's queue.
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY,
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  created_at timestamptz NOT NULL,
  sent_at timestamptz,
  claimed_at timestamptz,
  claimed_by text,
  lease_until timestamptz
);
CREATE INDEX notification_outbox_due_idx ON notification_outbox (status, next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX notification_outbox_vehicle_idx ON notification_outbox (vehicle_id, user_id, status);
