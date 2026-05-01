-- ─────────────────────────────────────────────────────────────────────────
-- Re-sync denormalised text-code columns on referring tables from the
-- current master codes via the id-FK columns. Idempotent.
--
-- Use this any time you suspect text columns drifted from master codes
-- (e.g. a trigger missed a propagation, or pre-trigger data is stale).
-- The id-FKs are the source of truth; the text columns are caches.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE mtts_assets a SET plant = p.code
FROM mtts_plants p
WHERE a.plant_id = p.id AND a.plant IS DISTINCT FROM p.code;

UPDATE mtts_assets a SET asset_type = t.code
FROM mtts_asset_types t
WHERE a.asset_type_id = t.id AND a.asset_type IS DISTINCT FROM t.code;

UPDATE mtts_assets a SET primary_name = pn.code
FROM mtts_asset_primary_names pn
WHERE a.primary_name_id = pn.id AND a.primary_name IS DISTINCT FROM pn.code;

UPDATE mtts_tickets t SET plant = p.code
FROM mtts_plants p
WHERE t.plant_id = p.id AND t.plant IS DISTINCT FROM p.code;

UPDATE mtts_tickets t SET asset_code = a.code
FROM mtts_assets a
WHERE t.asset_id = a.id AND t.asset_code IS DISTINCT FROM a.code;
