-- 0002 audit events: append-only record used by recovery and ownership flows.
-- Actor and subject columns are plain uuids; foreign keys arrive with the
-- accounts and vehicles migrations that own those tables.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  action text NOT NULL CHECK (action <> ''),
  subject_type text,
  subject_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_subject_idx ON audit_events (subject_type, subject_id, occurred_at);
