-- API keys phase 4: service visit source ids and import preview binding.
--
-- external_id is an optional client-supplied stable id (for example the id a
-- garage system or a script gave the visit). It is unique per vehicle when set,
-- so a re-run of the same import is recognised exactly instead of guessed from
-- date, odometer and items.
ALTER TABLE service_visits
  ADD COLUMN external_id text CHECK (external_id IS NULL OR (char_length(external_id) BETWEEN 1 AND 200 AND external_id = btrim(external_id)));
CREATE UNIQUE INDEX service_visits_external_id_idx ON service_visits (vehicle_id, external_id) WHERE external_id IS NOT NULL;

-- A preview of a bulk write made with an API key. The commit must present the
-- token of a preview of the same key, the same target and the same canonical
-- payload digest, before it expires. Credential-adjacent state: removed with the
-- key, excluded from backups (EPHEMERAL_TABLES in src/backup.ts). Only a hash of
-- the token is stored.
CREATE TABLE api_key_import_previews (
  id uuid PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  target text NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX api_key_import_previews_key_idx ON api_key_import_previews (key_id, expires_at);
