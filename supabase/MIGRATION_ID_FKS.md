# MTTS — id-based foreign keys migration

## Why

Referring tables (`mtts_assets`, `mtts_tickets`) currently store the master's
user-facing `code text` as the soft pointer. That makes:

1. **Renames fragile** — you can't UPDATE a row's `code` via Supabase upsert
   (which keys on `code`), so renames went INSERT-then-DELETE through three
   non-transactional calls. Any silent failure left orphans.
2. **Deletes silent** — without proper FK constraints there's no DB-level
   guarantee that deleting a master row doesn't dangle live references.
3. **Identity coupled to display** — every cosmetic code change has to walk
   every referring table.

The fix: switch every FK column to point at the master's stable `bigint id`
(already present), make `code` purely cosmetic. Renames become a single
UPDATE on one column. Deletes get a real DB-level error.

## Three phases

Each phase is independently reversible.

| Phase | What changes | Reversible by |
|-------|--------------|---------------|
| **1** | Add `*_id` columns + backfill + FKs alongside existing text columns. App keeps using text codes; new columns just shadow them. | Drop the new columns. |
| **2** | App switches to read/write by id. Text columns kept as a read-only mirror via trigger so older clients still work briefly. | Revert the JS deploy. |
| **3** | Drop the text FK columns and the mirror trigger. Codes stay only on the masters themselves. | Restore from backup or re-add columns + backfill. |

Phase 1 is purely additive and risk-free for the live app. Phase 2 needs
the new app version deployed at the same time. Phase 3 is the cleanup.

## Phase 1 — schema additions (run in Supabase SQL editor)

Lives in `supabase/migrations/20260501_01_add_id_fk_columns.sql`. It is
idempotent — safe to re-run.

After running, verify with:

```sql
-- Should return 0 — every non-empty text code resolves to an id
SELECT COUNT(*) FROM mtts_assets WHERE plant <> '' AND plant_id IS NULL;
SELECT COUNT(*) FROM mtts_assets WHERE asset_type <> '' AND asset_type_id IS NULL;
SELECT COUNT(*) FROM mtts_assets WHERE primary_name <> '' AND primary_name_id IS NULL;
SELECT COUNT(*) FROM mtts_tickets WHERE plant <> '' AND plant_id IS NULL;
SELECT COUNT(*) FROM mtts_tickets WHERE asset_code <> '' AND asset_id IS NULL;
```

If anything returns > 0, it's an existing orphan — delete it from the
referring table or fix the pointer before proceeding.

**Rollback (if you need to undo Phase 1):**

```sql
ALTER TABLE mtts_assets DROP CONSTRAINT IF EXISTS mtts_assets_plant_id_fk;
ALTER TABLE mtts_assets DROP CONSTRAINT IF EXISTS mtts_assets_asset_type_id_fk;
ALTER TABLE mtts_assets DROP CONSTRAINT IF EXISTS mtts_assets_primary_name_id_fk;
ALTER TABLE mtts_tickets DROP CONSTRAINT IF EXISTS mtts_tickets_plant_id_fk;
ALTER TABLE mtts_tickets DROP CONSTRAINT IF EXISTS mtts_tickets_asset_id_fk;
ALTER TABLE mtts_assets DROP COLUMN IF EXISTS plant_id;
ALTER TABLE mtts_assets DROP COLUMN IF EXISTS asset_type_id;
ALTER TABLE mtts_assets DROP COLUMN IF EXISTS primary_name_id;
ALTER TABLE mtts_tickets DROP COLUMN IF EXISTS plant_id;
ALTER TABLE mtts_tickets DROP COLUMN IF EXISTS asset_id;
```

## Phase 2 — JS flips to id (next PR)

Steps that will land together in the app code:

1. `_toRow` / `_fromRow` mappers serialize / hydrate `*_id` and the lookup
   helpers translate to/from the cosmetic code.
2. Asset / ticket save/load reads the id, resolves to code only for display.
3. Cascade-rename code is removed entirely — there's no cascade needed
   anymore because `id` doesn't change on rename.
4. Every place that filters or matches on `a.plant === code` becomes
   `a.plantId === id`.
5. A Postgres trigger keeps the legacy `plant`/`asset_type`/`primary_name`/
   `asset_code` text columns in sync with the new `*_id` columns, so older
   tabs running the previous build don't crash during the deploy.

## Phase 3 — drop text columns (final PR)

Once Phase 2 has been live for a deploy cycle and nothing depends on the
text columns:

```sql
DROP TRIGGER IF EXISTS mtts_assets_sync_text_codes ON mtts_assets;
DROP TRIGGER IF EXISTS mtts_tickets_sync_text_codes ON mtts_tickets;
DROP FUNCTION IF EXISTS mtts_assets_sync_codes();
DROP FUNCTION IF EXISTS mtts_tickets_sync_codes();

ALTER TABLE mtts_assets DROP COLUMN IF EXISTS plant;
ALTER TABLE mtts_assets DROP COLUMN IF EXISTS asset_type;
ALTER TABLE mtts_assets DROP COLUMN IF EXISTS primary_name;
ALTER TABLE mtts_tickets DROP COLUMN IF EXISTS plant;
ALTER TABLE mtts_tickets DROP COLUMN IF EXISTS asset_code;
```

After this, codes are purely a display detail of the masters. Renaming a
plant code is a one-line UPDATE on `mtts_plants.code`, no cascade needed,
no orphans possible.
