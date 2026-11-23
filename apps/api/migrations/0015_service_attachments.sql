-- 0015 receipt and invoice attachments on service visits. Bytes live in
-- Postgres (like vehicle images), so the generic backup and the vehicle export
-- carry them. Deleting a visit, and so a vehicle, deletes its attachments.
CREATE TABLE service_attachments (
  id uuid PRIMARY KEY,
  visit_id uuid NOT NULL REFERENCES service_visits (id) ON DELETE CASCADE,
  file_name text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  data bytea NOT NULL,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_attachments_visit_idx ON service_attachments (visit_id, created_at, id);
