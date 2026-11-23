-- 0012 vehicle driver role. Adds `driver`: reads everything a viewer reads and
-- may add fill-ups and change or delete the ones they recorded, but cannot edit
-- the vehicle, its photo, import, or manage members. Existing rows keep their
-- role: no viewer is elevated. (`editor` is shown as "Authorized Manager".)
ALTER TABLE vehicle_members DROP CONSTRAINT vehicle_members_role_check;
ALTER TABLE vehicle_members ADD CONSTRAINT vehicle_members_role_check CHECK (role IN ('owner', 'editor', 'driver', 'viewer'));
