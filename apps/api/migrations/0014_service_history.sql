-- 0014 service history. A visit is one trip to a workshop (or one DIY session)
-- with one or more items. NULL cost means unknown; 0 means known to be free.
-- Odometer follows fuel: *_input and *_unit as entered, *_km normalised. It is
-- optional and never linked to fill_ups.
CREATE TABLE service_visits (
  id uuid PRIMARY KEY,
  vehicle_id uuid NOT NULL REFERENCES vehicles (id) ON DELETE CASCADE,
  serviced_on date NOT NULL,
  odometer_input numeric CHECK (odometer_input >= 0),
  odometer_unit text CHECK (odometer_unit IN ('km', 'mi')),
  odometer_km numeric(18, 6),
  provider text CHECK (provider IS NULL OR char_length(provider) BETWEEN 1 AND 120),
  is_diy boolean NOT NULL DEFAULT false,
  visit_total_cost numeric CHECK (visit_total_cost >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_visits_odometer_complete CHECK ((odometer_input IS NULL) = (odometer_unit IS NULL) AND (odometer_input IS NULL) = (odometer_km IS NULL))
);
CREATE INDEX service_visits_order_idx ON service_visits (vehicle_id, serviced_on DESC, created_at DESC, id DESC);

CREATE TABLE service_items (
  id uuid PRIMARY KEY,
  visit_id uuid NOT NULL REFERENCES service_visits (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  category text NOT NULL DEFAULT 'other' CHECK (category IN ('scheduled', 'repair', 'inspection', 'other')),
  cost numeric CHECK (cost >= 0),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 500),
  UNIQUE (visit_id, position)
);
