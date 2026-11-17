-- Instance-wide default display units and currency. The first administrator
-- chooses them at setup; administrators can change them later. At most one
-- row; with none, the built-in defaults apply (km, litres, L/100 km, USD).
-- No row is seeded here so that a restore can load the archived row.
CREATE TABLE instance_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  distance_unit text NOT NULL CHECK (distance_unit IN ('km', 'mi')),
  volume_unit text NOT NULL CHECK (volume_unit IN ('l', 'gal_us', 'gal_imp')),
  economy_unit text NOT NULL CHECK (economy_unit IN ('l_per_100km', 'km_per_l', 'mpg_us', 'mpg_imp')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A NULL preference follows the instance default, so a user who never chose a
-- unit sees the administrator's choice, including later changes to it.
-- Existing rows were explicit choices and keep their values.
ALTER TABLE user_preferences
  ALTER COLUMN distance_unit DROP NOT NULL, ALTER COLUMN distance_unit DROP DEFAULT,
  ALTER COLUMN volume_unit DROP NOT NULL, ALTER COLUMN volume_unit DROP DEFAULT,
  ALTER COLUMN economy_unit DROP NOT NULL, ALTER COLUMN economy_unit DROP DEFAULT,
  ALTER COLUMN currency DROP NOT NULL, ALTER COLUMN currency DROP DEFAULT;
