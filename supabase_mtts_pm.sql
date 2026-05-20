-- 260520-V18 — MTTS Preventive Maintenance (PM) schema migration.
-- Adds three columns to mtts_assets:
--   pm_applicable : whether this asset participates in PM (default false).
--   pm_schedule   : the recurring PM definition (frequency, last/next due,
--                   custom interval). JSONB so the shape can evolve.
--   pm_history    : append-only log of completed PMs ({at, by, by_id,
--                   notes, job_card_photo, next_due_after}). Excluded
--                   from the boot select so its base64 photos don't bloat
--                   bandwidth — lazy-loaded by _mttsLoadAssetPmHistory.
--
-- Safe to run multiple times: each column is added IF NOT EXISTS, and the
-- pgrst schema reload at the end picks up the new columns without app
-- restart. No data backfill needed — existing rows default to {pmApplicable=false,
-- pmSchedule={}, pmHistory=[]} which all downstream code treats as "no PM".

ALTER TABLE public.mtts_assets
  ADD COLUMN IF NOT EXISTS pm_applicable boolean NOT NULL DEFAULT false;

ALTER TABLE public.mtts_assets
  ADD COLUMN IF NOT EXISTS pm_schedule jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.mtts_assets
  ADD COLUMN IF NOT EXISTS pm_history jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Quick index for the dashboard "next due PM" widget: filters to
-- pm_applicable=true rows and orders by the next-due date inside the
-- JSONB. The expression index lets PostgREST sort/filter without a
-- full table scan once the table grows.
CREATE INDEX IF NOT EXISTS idx_mtts_assets_pm_next_due
  ON public.mtts_assets ((pm_schedule->>'nextDueAt'))
  WHERE pm_applicable = true;

NOTIFY pgrst, 'reload schema';
