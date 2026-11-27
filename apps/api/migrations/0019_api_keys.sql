-- API keys: personal, revocable bearer credentials with fine-grained grants.
--
-- Only a SHA-256 of the token is stored (plus a short display prefix); the
-- secret itself is shown once and never persisted. api_keys, its bindings and
-- the idempotency records are credentials: backups exclude them (EPHEMERAL_TABLES
-- in src/backup.ts) and a restore leaves them empty. api_key_activity is the
-- owner-visible history: it has no foreign keys (like audit_events), so it
-- survives key removal and restore, and it never authenticates anything.

CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 60),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_prefix text NOT NULL CHECK (char_length(token_prefix) = 12),
  vehicle_mode text NOT NULL CHECK (vehicle_mode IN ('selected', 'all_current', 'all_current_future')),
  allow_vehicle_create boolean NOT NULL DEFAULT false,
  -- Bumped by every rotation. NULL expires_at means the key never expires.
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IS NULL OR revoked_reason IN ('user', 'revoke_all', 'account_recovery', 'operator_recovery', 'account_disabled', 'account_deleted')),
  CONSTRAINT api_keys_revoked_reason CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id, created_at, id);

-- A missing row means level `none`. Only levels a module offers are accepted
-- (mirrors SUPPORTED_LEVELS in src/auth/api-key-policy.ts); vehicle creation is
-- the boolean api_keys.allow_vehicle_create, not a row here.
CREATE TABLE api_key_permissions (
  key_id uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  module text NOT NULL,
  level text NOT NULL,
  PRIMARY KEY (key_id, module),
  CONSTRAINT api_key_permissions_module CHECK (module IN ('vehicle_info', 'vehicle_settings', 'fuel', 'service', 'maintenance', 'notifications', 'statistics')),
  CONSTRAINT api_key_permissions_level CHECK (level IN ('read', 'read_write', 'full')),
  CONSTRAINT api_key_permissions_supported CHECK (
    (module IN ('vehicle_info', 'statistics') AND level = 'read')
    OR (module = 'vehicle_settings' AND level IN ('read_write', 'full'))
    OR (module = 'notifications' AND level IN ('read', 'read_write'))
    OR (module IN ('fuel', 'service', 'maintenance')))
);

-- The vehicle snapshot of `selected` and `all_current` keys. Empty for
-- `all_current_future`, which is resolved live from current membership.
CREATE TABLE api_key_vehicles (
  key_id uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, vehicle_id)
);
CREATE INDEX api_key_vehicles_vehicle_idx ON api_key_vehicles (vehicle_id);

-- Instance-wide switches. A missing row means the default, which for
-- `api_keys` is enabled (so existing and new installs need no seeding).
CREATE TABLE instance_flags (
  flag text PRIMARY KEY CHECK (flag IN ('api_keys')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Owner-visible key history. key_id and user_id deliberately have no foreign
-- key: history outlives key removal, restore and (anonymised) account removal.
-- Never holds tokens, payloads or receipt content: `metadata` is small and safe.
CREATE TABLE api_key_activity (
  id uuid PRIMARY KEY,
  key_id uuid NOT NULL,
  user_id uuid NOT NULL,
  key_name text NOT NULL DEFAULT '',
  action text NOT NULL CHECK (action <> ''),
  target_type text,
  target_ids uuid[] NOT NULL DEFAULT '{}',
  vehicle_id uuid,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_key_activity_key_idx ON api_key_activity (key_id, id DESC);
CREATE INDEX api_key_activity_user_idx ON api_key_activity (user_id, id DESC);

-- Committed outcomes of idempotent requests (used by bearer writes). Credential
-- state: excluded from backups. Rows expire (at least 24 hours after creation).
CREATE TABLE api_key_idempotency (
  id uuid PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  operation text NOT NULL,
  target text,
  request_fingerprint text NOT NULL,
  response_status integer,
  response_meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (key_id, idempotency_key)
);
CREATE INDEX api_key_idempotency_expiry_idx ON api_key_idempotency (expires_at);
