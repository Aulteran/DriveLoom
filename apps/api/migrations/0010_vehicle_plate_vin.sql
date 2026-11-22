-- 0010 optional nickname, licence plate and VIN.
-- The nickname becomes optional. Plate and VIN are private to the vehicle's
-- members and are never exposed to friends or comparisons. Deliberately no
-- UNIQUE constraint on plate or VIN: a conflict error would reveal to one user
-- that another user registered the same identifier.
ALTER TABLE vehicles ALTER COLUMN name DROP NOT NULL;
ALTER TABLE vehicles
  ADD COLUMN plate_region text CHECK (plate_region IS NULL OR char_length(plate_region) BETWEEN 1 AND 10),
  ADD COLUMN plate_number text CHECK (plate_number IS NULL OR char_length(plate_number) BETWEEN 1 AND 12),
  ADD COLUMN vin text CHECK (vin IS NULL OR char_length(vin) BETWEEN 5 AND 17);
