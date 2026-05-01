-- ─────────────────────────────────────────────────────────────────────────
-- Phase 1: add bigint id-based FK columns alongside the existing text
-- code columns. Backfill from the current text codes, add proper FK
-- constraints. The app keeps using the text columns for now — the new
-- columns just shadow them. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Add the new id columns (no FK yet, no NOT NULL). Types match each
--    master's id column: mtts_plants.id and mtts_assets.id are uuid;
--    mtts_asset_types.id and mtts_asset_primary_names.id are bigint.
ALTER TABLE mtts_assets  ADD COLUMN IF NOT EXISTS plant_id        uuid;
ALTER TABLE mtts_assets  ADD COLUMN IF NOT EXISTS asset_type_id   bigint;
ALTER TABLE mtts_assets  ADD COLUMN IF NOT EXISTS primary_name_id bigint;
ALTER TABLE mtts_tickets ADD COLUMN IF NOT EXISTS plant_id        uuid;
ALTER TABLE mtts_tickets ADD COLUMN IF NOT EXISTS asset_id        uuid;

-- 2. Backfill from existing text codes — only fill rows whose new column
--    is still NULL so re-runs are safe.
UPDATE mtts_assets a
   SET plant_id = p.id
  FROM mtts_plants p
 WHERE a.plant = p.code
   AND a.plant <> ''
   AND a.plant_id IS NULL;

UPDATE mtts_assets a
   SET asset_type_id = t.id
  FROM mtts_asset_types t
 WHERE a.asset_type = t.code
   AND a.asset_type <> ''
   AND a.asset_type_id IS NULL;

UPDATE mtts_assets a
   SET primary_name_id = pn.id
  FROM mtts_asset_primary_names pn
 WHERE a.primary_name = pn.code
   AND a.primary_name <> ''
   AND a.primary_name_id IS NULL;

UPDATE mtts_tickets t
   SET plant_id = p.id
  FROM mtts_plants p
 WHERE t.plant = p.code
   AND t.plant <> ''
   AND t.plant_id IS NULL;

UPDATE mtts_tickets t
   SET asset_id = a.id
  FROM mtts_assets a
 WHERE t.asset_code = a.code
   AND t.asset_code <> ''
   AND t.asset_id IS NULL;

-- 3. Replace the older text-code FKs (added in an earlier session) with
--    proper id-based FKs. Drop first so re-runs don't choke on duplicates.
ALTER TABLE mtts_assets DROP CONSTRAINT IF EXISTS mtts_assets_plant_fk;
ALTER TABLE mtts_assets DROP CONSTRAINT IF EXISTS mtts_assets_asset_type_fk;
ALTER TABLE mtts_assets DROP CONSTRAINT IF EXISTS mtts_assets_primary_name_fk;
ALTER TABLE mtts_tickets DROP CONSTRAINT IF EXISTS mtts_tickets_plant_fk;
ALTER TABLE mtts_tickets DROP CONSTRAINT IF EXISTS mtts_tickets_asset_code_fk;

ALTER TABLE mtts_assets DROP CONSTRAINT IF EXISTS mtts_assets_plant_id_fk;
ALTER TABLE mtts_assets DROP CONSTRAINT IF EXISTS mtts_assets_asset_type_id_fk;
ALTER TABLE mtts_assets DROP CONSTRAINT IF EXISTS mtts_assets_primary_name_id_fk;
ALTER TABLE mtts_tickets DROP CONSTRAINT IF EXISTS mtts_tickets_plant_id_fk;
ALTER TABLE mtts_tickets DROP CONSTRAINT IF EXISTS mtts_tickets_asset_id_fk;

ALTER TABLE mtts_assets
  ADD CONSTRAINT mtts_assets_plant_id_fk
  FOREIGN KEY (plant_id) REFERENCES mtts_plants(id)
  ON DELETE RESTRICT;

ALTER TABLE mtts_assets
  ADD CONSTRAINT mtts_assets_asset_type_id_fk
  FOREIGN KEY (asset_type_id) REFERENCES mtts_asset_types(id)
  ON DELETE RESTRICT;

ALTER TABLE mtts_assets
  ADD CONSTRAINT mtts_assets_primary_name_id_fk
  FOREIGN KEY (primary_name_id) REFERENCES mtts_asset_primary_names(id)
  ON DELETE RESTRICT;

ALTER TABLE mtts_tickets
  ADD CONSTRAINT mtts_tickets_plant_id_fk
  FOREIGN KEY (plant_id) REFERENCES mtts_plants(id)
  ON DELETE RESTRICT;

ALTER TABLE mtts_tickets
  ADD CONSTRAINT mtts_tickets_asset_id_fk
  FOREIGN KEY (asset_id) REFERENCES mtts_assets(id)
  ON DELETE RESTRICT;

-- 4. Index the new FK columns for join performance and to make
--    cascade-on-delete checks fast.
CREATE INDEX IF NOT EXISTS mtts_assets_plant_id_idx
  ON mtts_assets (plant_id);
CREATE INDEX IF NOT EXISTS mtts_assets_asset_type_id_idx
  ON mtts_assets (asset_type_id);
CREATE INDEX IF NOT EXISTS mtts_assets_primary_name_id_idx
  ON mtts_assets (primary_name_id);
CREATE INDEX IF NOT EXISTS mtts_tickets_plant_id_idx
  ON mtts_tickets (plant_id);
CREATE INDEX IF NOT EXISTS mtts_tickets_asset_id_idx
  ON mtts_tickets (asset_id);

-- 5. Trigger to keep new id columns in sync when older clients write text
--    codes. Runs on INSERT/UPDATE — looks up the matching master id by
--    the text code and stamps it onto the row before it lands.
CREATE OR REPLACE FUNCTION mtts_assets_sync_ids() RETURNS trigger AS $$
BEGIN
  IF NEW.plant IS NOT NULL AND NEW.plant <> '' AND
     (NEW.plant_id IS NULL OR
      NEW.plant IS DISTINCT FROM (SELECT code FROM mtts_plants WHERE id = NEW.plant_id)) THEN
    SELECT id INTO NEW.plant_id FROM mtts_plants WHERE code = NEW.plant;
  END IF;
  IF NEW.asset_type IS NOT NULL AND NEW.asset_type <> '' AND
     (NEW.asset_type_id IS NULL OR
      NEW.asset_type IS DISTINCT FROM (SELECT code FROM mtts_asset_types WHERE id = NEW.asset_type_id)) THEN
    SELECT id INTO NEW.asset_type_id FROM mtts_asset_types WHERE code = NEW.asset_type;
  END IF;
  IF NEW.primary_name IS NOT NULL AND NEW.primary_name <> '' AND
     (NEW.primary_name_id IS NULL OR
      NEW.primary_name IS DISTINCT FROM (SELECT code FROM mtts_asset_primary_names WHERE id = NEW.primary_name_id)) THEN
    SELECT id INTO NEW.primary_name_id FROM mtts_asset_primary_names WHERE code = NEW.primary_name;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mtts_assets_sync_ids_trg ON mtts_assets;
CREATE TRIGGER mtts_assets_sync_ids_trg
  BEFORE INSERT OR UPDATE ON mtts_assets
  FOR EACH ROW EXECUTE FUNCTION mtts_assets_sync_ids();

CREATE OR REPLACE FUNCTION mtts_tickets_sync_ids() RETURNS trigger AS $$
BEGIN
  IF NEW.plant IS NOT NULL AND NEW.plant <> '' AND
     (NEW.plant_id IS NULL OR
      NEW.plant IS DISTINCT FROM (SELECT code FROM mtts_plants WHERE id = NEW.plant_id)) THEN
    SELECT id INTO NEW.plant_id FROM mtts_plants WHERE code = NEW.plant;
  END IF;
  IF NEW.asset_code IS NOT NULL AND NEW.asset_code <> '' AND
     (NEW.asset_id IS NULL OR
      NEW.asset_code IS DISTINCT FROM (SELECT code FROM mtts_assets WHERE id = NEW.asset_id)) THEN
    SELECT id INTO NEW.asset_id FROM mtts_assets WHERE code = NEW.asset_code;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mtts_tickets_sync_ids_trg ON mtts_tickets;
CREATE TRIGGER mtts_tickets_sync_ids_trg
  BEFORE INSERT OR UPDATE ON mtts_tickets
  FOR EACH ROW EXECUTE FUNCTION mtts_tickets_sync_ids();
