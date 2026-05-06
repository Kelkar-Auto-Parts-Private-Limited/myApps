-- ─────────────────────────────────────────────────────────────────────────
-- Phase 3: AFTER-UPDATE-OF-code triggers on each master table that
-- propagate code renames into referring tables' denormalised text
-- columns. With these in place, a code rename is a single Postgres
-- UPDATE on the master — the JS layer no longer has to walk referrers.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- Plants → assets/tickets
CREATE OR REPLACE FUNCTION mtts_plants_propagate_code() RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    UPDATE mtts_assets  SET plant = NEW.code WHERE plant_id  = NEW.id;
    UPDATE mtts_tickets SET plant = NEW.code WHERE plant_id  = NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mtts_plants_propagate_code_trg ON mtts_plants;
CREATE TRIGGER mtts_plants_propagate_code_trg
  AFTER UPDATE OF code ON mtts_plants
  FOR EACH ROW EXECUTE FUNCTION mtts_plants_propagate_code();

-- Asset types → assets
CREATE OR REPLACE FUNCTION mtts_asset_types_propagate_code() RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    UPDATE mtts_assets SET asset_type = NEW.code WHERE asset_type_id = NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mtts_asset_types_propagate_code_trg ON mtts_asset_types;
CREATE TRIGGER mtts_asset_types_propagate_code_trg
  AFTER UPDATE OF code ON mtts_asset_types
  FOR EACH ROW EXECUTE FUNCTION mtts_asset_types_propagate_code();

-- Primary names → assets
CREATE OR REPLACE FUNCTION mtts_aprim_propagate_code() RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    UPDATE mtts_assets SET primary_name = NEW.code WHERE primary_name_id = NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mtts_aprim_propagate_code_trg ON mtts_asset_primary_names;
CREATE TRIGGER mtts_aprim_propagate_code_trg
  AFTER UPDATE OF code ON mtts_asset_primary_names
  FOR EACH ROW EXECUTE FUNCTION mtts_aprim_propagate_code();

-- Assets → tickets
CREATE OR REPLACE FUNCTION mtts_assets_propagate_code() RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    UPDATE mtts_tickets SET asset_code = NEW.code WHERE asset_id = NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mtts_assets_propagate_code_trg ON mtts_assets;
CREATE TRIGGER mtts_assets_propagate_code_trg
  AFTER UPDATE OF code ON mtts_assets
  FOR EACH ROW EXECUTE FUNCTION mtts_assets_propagate_code();
