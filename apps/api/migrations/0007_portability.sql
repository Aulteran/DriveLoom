-- 0007 images, invitations (milestone 1.6).

-- One image per vehicle, kept in the database so a backup is one consistent
-- snapshot and needs no second storage system. Size is capped by the API.
CREATE TABLE vehicle_images (
  vehicle_id uuid PRIMARY KEY REFERENCES vehicles (id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data bytea NOT NULL,
  uploaded_by uuid REFERENCES users (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Invitations let an administrator admit users while registration is closed.
-- Only a hash of the token is stored.
CREATE TABLE invites (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  email text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid REFERENCES users (id)
);
