-- ─────────────────────────────────────────────────────────────────────────
-- Extend the AFTER UPDATE OF code trigger on mtts_asset_types so it
-- also propagates the new code into mtts_asset_primary_names.asset_type
-- (which stores the asset-type code as a denormalised text column).
-- The original trigger only touched mtts_assets, leaving primary names
-- stale after a code rename.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION mtts_asset_types_propagate_code() RETURNS trigger AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    UPDATE mtts_assets              SET asset_type = NEW.code WHERE asset_type = OLD.code;
    UPDATE mtts_asset_primary_names SET asset_type = NEW.code WHERE asset_type = OLD.code;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Trigger itself was attached in 20260501_02; CREATE OR REPLACE on the
-- function swaps in the new body without touching the trigger binding.
