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

-- Password sign-in. `hash` is a self-describing scrypt string.
CREATE TABLE password_credentials (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One TOTP authenticator per user. The secret is encrypted with the instance
-- secret key. `last_step` is the newest accepted 30 s step, so a code can
-- never be accepted twice.
CREATE TABLE totp_credentials (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  secret_enc text NOT NULL,
  confirmed_at timestamptz,
  last_step bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Single-use recovery codes for a lost TOTP device; only HMACs are stored.
CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  code_hash text NOT NULL,
  used_at timestamptz,
  UNIQUE (user_id, code_hash)
);

-- Any number of passkeys per user.
CREATE TABLE passkeys (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);

-- OIDC identities are bound to issuer + subject, never to an email address.
CREATE TABLE oidc_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  issuer text NOT NULL,
  subject text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE INDEX oidc_identities_user_idx ON oidc_identities (user_id);

-- Browser sessions. Only a SHA-256 of the cookie token is stored.
-- state 'pending' = first factor done, second factor outstanding.
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'active')),
  created_at timestamptz NOT NULL DEFAULT now(),
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Emailed one-time codes (email verification, password recovery).
CREATE TABLE one_time_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'recover_account')),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX one_time_codes_user_idx ON one_time_codes (user_id, purpose);

-- Server-side state for WebAuthn ceremonies and OIDC redirects. `key` is the
-- WebAuthn challenge or a hash of the OIDC state; each row is consumed once.
CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('webauthn_register', 'webauthn_login', 'oidc')),
  key text NOT NULL UNIQUE,
  user_id uuid REFERENCES users (id),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

-- Fixed-window rate limit counters (keys are hashed identifiers, never raw emails).
CREATE TABLE rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
