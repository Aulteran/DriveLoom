-- Administrator-managed SMTP and OIDC settings. One row per integration.
-- `config` holds the non-secret fields; the SMTP password and the OIDC client
-- secret are AES-256-GCM encrypted with the instance secret key in `secret_enc`
-- and are never returned by the API. Environment variables, when set, take
-- precedence over these rows. A backup archives these rows as ciphertext: it
-- restores only into an instance with the same DRIVELOOM_SECRET_KEY, and
-- otherwise the secret must be entered again (the server starts without it).
CREATE TABLE integration_settings (
  kind text PRIMARY KEY CHECK (kind IN ('smtp', 'oidc')),
  config jsonb NOT NULL,
  secret_enc text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
