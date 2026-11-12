-- 0005 fuel, units and costs (milestone 1.4).

-- The physical odometer unit and the reporting currency belong to the vehicle.
ALTER TABLE vehicles
  ADD COLUMN odometer_unit text NOT NULL DEFAULT 'km' CHECK (odometer_unit IN ('km', 'mi')),
  ADD COLUMN currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$');

-- Account-wide display preferences. A missing row means the defaults.
CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  distance_unit text NOT NULL DEFAULT 'km' CHECK (distance_unit IN ('km', 'mi')),
  volume_unit text NOT NULL DEFAULT 'l' CHECK (volume_unit IN ('l', 'gal_us', 'gal_imp')),
  economy_unit text NOT NULL DEFAULT 'l_per_100km' CHECK (economy_unit IN ('l_per_100km', 'km_per_l', 'mpg_us', 'mpg_imp')),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A fuel purchase. *_input and *_unit are exactly what the user entered
-- (unconstrained numeric keeps the entered scale); *_km and *_l are the
-- normalised base-unit values every calculation uses.
CREATE TABLE fill_ups (
  id uuid PRIMARY KEY,
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  odometer_input numeric NOT NULL CHECK (odometer_input >= 0),
  odometer_unit text NOT NULL CHECK (odometer_unit IN ('km', 'mi')),
  odometer_km numeric(18, 6) NOT NULL,
  volume_input numeric NOT NULL CHECK (volume_input > 0),
  volume_unit text NOT NULL CHECK (volume_unit IN ('l', 'gal_us', 'gal_imp')),
  volume_l numeric(18, 9) NOT NULL,
  is_full boolean NOT NULL DEFAULT true,
  missed_previous boolean NOT NULL DEFAULT false,
  -- Source money as paid, plus its value in the vehicle's reporting currency.
  cost_amount numeric CHECK (cost_amount >= 0),
  cost_currency text CHECK (cost_currency ~ '^[A-Z]{3}$'),
  exchange_rate numeric CHECK (exchange_rate > 0),
  reporting_amount numeric CHECK (reporting_amount >= 0),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 500),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fill_ups_cost_complete CHECK ((cost_amount IS NULL) = (cost_currency IS NULL) AND (cost_amount IS NULL) = (reporting_amount IS NULL)),
  -- Same vehicle, instant and odometer is the same purchase entered twice.
  CONSTRAINT fill_ups_no_duplicate UNIQUE (vehicle_id, occurred_at, odometer_km)
);
-- Authoritative chronological order.
CREATE INDEX fill_ups_order_idx ON fill_ups (vehicle_id, occurred_at, odometer_km, id);
