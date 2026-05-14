-- ═══════════════════════════════════════════════════════════════════════════
-- HWMS data_version key + trigger
-- ───────────────────────────────────────────────────────────────────────────
-- Adds a single key/value row that auto-increments on every INSERT / UPDATE
-- / DELETE against any public.hwms_* table.  The client reads this version
-- via hwms_data_version() RPC and skips re-fetching cached tables if the
-- version hasn't moved since its last snapshot.
--
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Storage table.
CREATE TABLE IF NOT EXISTS public.hwms_meta (
  key        text       PRIMARY KEY,
  value      bigint     NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO public.hwms_meta (key, value)
  VALUES ('data_version', 0)
  ON CONFLICT (key) DO NOTHING;

-- 2) Trigger fn — bumps the counter on every HWMS table mutation.
CREATE OR REPLACE FUNCTION public.hwms_bump_data_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.hwms_meta
     SET value = value + 1, updated_at = now()
   WHERE key = 'data_version';
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 3) Attach the trigger to every public.hwms_* table (skipping hwms_meta
--    itself to avoid recursion). Re-runnable: drops then creates.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename  LIKE 'hwms_%'
       AND tablename  <> 'hwms_meta'
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_hwms_bump_data_version ON public.%I;',
      r.tablename
    );
    EXECUTE format(
      'CREATE TRIGGER trg_hwms_bump_data_version
         AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.hwms_bump_data_version();',
      r.tablename
    );
  END LOOP;
END $$;

-- 4) Read RPC — cheap one-row lookup, no PII so no auth gate needed.
CREATE OR REPLACE FUNCTION public.hwms_data_version()
RETURNS bigint
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT COALESCE((SELECT value FROM public.hwms_meta WHERE key = 'data_version'), 0);
$$;

GRANT EXECUTE ON FUNCTION public.hwms_data_version() TO authenticated, anon;

-- Done. Verify with:
--   SELECT * FROM public.hwms_meta;
--   SELECT public.hwms_data_version();
