-- 0006 friends and comparison opt-in (milestone 1.5). Friendship is separate
-- from vehicle membership and grants no access to any vehicle record.
CREATE TABLE friendships (
  id uuid PRIMARY KEY,
  requester_id uuid NOT NULL REFERENCES users (id),
  addressee_id uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  CHECK (requester_id <> addressee_id)
);
-- One relationship per pair, whichever side asked.
CREATE UNIQUE INDEX friendships_pair_key ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
CREATE INDEX friendships_addressee_idx ON friendships (addressee_id);

-- A row means the owner opted this vehicle in to aggregate comparison with
-- their accepted friends. Deleting the row revokes it immediately.
CREATE TABLE vehicle_comparison_optins (
  vehicle_id uuid PRIMARY KEY REFERENCES vehicles (id) ON DELETE CASCADE,
  enabled_by uuid NOT NULL REFERENCES users (id),
  enabled_at timestamptz NOT NULL DEFAULT now()
);
