-- ─────────────────────────────────────────────────────────────────────────
-- Phase: collapse `code` to `name` on Plant and Asset Type masters.
-- The user-facing "Short Code" field is removed from the UI; Name now
-- doubles as the identifier (matching the Primary Name pattern). This
-- migration makes the existing rows match the new convention so Name
-- == code everywhere.
--
-- The AFTER UPDATE OF code triggers on each master propagate the new
-- code to denormalised text columns on referring tables atomically.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE mtts_plants      SET code = name WHERE code IS DISTINCT FROM name;
UPDATE mtts_asset_types SET code = name WHERE code IS DISTINCT FROM name;
