-- ============================================================================
-- HWMS Lockdown Migration
-- Wraps all HWMS reads/writes in SECURITY DEFINER RPCs, then enables RLS and
-- revokes anon access on the tables. Lets the browser's anon-key client keep
-- calling Supabase directly without sharing a table-level key to the data.
--
-- DEPLOY ORDER
--   1. Run PART 1 + PART 2 (creates RPCs + grants). Safe — existing behaviour
--      is unchanged because the tables remain accessible via PostgREST.
--   2. Update the client to route hwms_* I/O through the RPCs and redeploy.
--   3. Verify HWMS pages load, save, delete, import, and export correctly.
--   4. Uncomment and run PART 3 to enable RLS + revoke anon.
--   5. To roll back: comment out PART 3 block, run
--         DO $$ DECLARE t TEXT;
--         BEGIN FOREACH t IN ARRAY ARRAY[...15 tables...] LOOP
--           EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
--           EXECUTE format('GRANT ALL ON %I TO anon, authenticated', t);
--         END LOOP; END $$;
-- ============================================================================

-- ========== PART 1 — HELPERS ==========

-- Raises an exception if username/token doesn't resolve to an active user.
-- Returns the user's `code` on success. Mirrors verify_session from the
-- existing auth migration.
CREATE OR REPLACE FUNCTION hwms_assert_session(p_username TEXT, p_token TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_code TEXT;
BEGIN
  SELECT u.code INTO v_code
  FROM vms_users u
  WHERE LOWER(u.name) = LOWER(p_username)
    AND u.session_token = p_token
    AND p_token IS NOT NULL AND p_token <> ''
    AND (u.inactive IS NULL OR u.inactive = false);
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'Invalid session' USING ERRCODE = '28000';
  END IF;
  RETURN v_code;
END $$;

-- Raises if the user has no HWMS access. "Access" = non-empty hwms_roles
-- array OR Super Admin in the top-level roles array.
CREATE OR REPLACE FUNCTION hwms_assert_access(p_username TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM vms_users u
    WHERE LOWER(u.name) = LOWER(p_username)
      AND (
        (u.hwms_roles IS NOT NULL
           AND jsonb_typeof(u.hwms_roles) = 'array'
           AND jsonb_array_length(u.hwms_roles) > 0)
        OR (u.roles ? 'Super Admin')
      )
  ) INTO v_has;
  IF NOT v_has THEN
    RAISE EXCEPTION 'No HWMS access' USING ERRCODE = '42501';
  END IF;
END $$;

-- Whitelist — prevents table-name injection through the generic RPCs.
CREATE OR REPLACE FUNCTION hwms_assert_table(p_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_table NOT IN (
    'hwms_parts','hwms_invoices','hwms_containers','hwms_hsn','hwms_uom',
    'hwms_packing','hwms_customers','hwms_port_discharge','hwms_port_loading',
    'hwms_carriers','hwms_company','hwms_steel_rates','hwms_sub_invoices',
    'hwms_material_requests','hwms_payment_receipts'
  ) THEN
    RAISE EXCEPTION 'Table not allowed: %', p_table USING ERRCODE = '42501';
  END IF;
END $$;

-- ========== PART 2 — READ / WRITE / DELETE RPCs ==========

-- Full-table read. Returns a JSON array of row objects (to_jsonb(t.*)).
CREATE OR REPLACE FUNCTION hwms_read(p_username TEXT, p_token TEXT, p_table TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  PERFORM hwms_assert_session(p_username, p_token);
  PERFORM hwms_assert_access(p_username);
  PERFORM hwms_assert_table(p_table);
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), ''[]''::jsonb) FROM %I t',
    p_table
  ) INTO v_result;
  RETURN v_result;
END $$;

-- Upsert a single row keyed on `code`. Returns the persisted row as JSONB.
-- NOTE: `id` is GENERATED ALWAYS AS IDENTITY on most HWMS tables, so we must
-- list the target columns explicitly and omit `id` from both the INSERT
-- column-list and the projection. Using `jsonb_populate_record(null::tbl, ...)`
-- would otherwise try to insert NULL into the identity column and fail.
CREATE OR REPLACE FUNCTION hwms_upsert(
  p_username TEXT, p_token TEXT, p_table TEXT, p_row JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB; v_cols_ins TEXT; v_cols_upd TEXT;
BEGIN
  PERFORM hwms_assert_session(p_username, p_token);
  PERFORM hwms_assert_access(p_username);
  PERFORM hwms_assert_table(p_table);
  IF p_row IS NULL OR NOT (p_row ? 'code') THEN
    RAISE EXCEPTION '`code` is required in payload' USING ERRCODE = '22004';
  END IF;

  -- Every column EXCEPT `id` — used for both the INSERT column-list and the
  -- projection from jsonb_populate_record.
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols_ins
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = p_table
     AND column_name <> 'id';
  -- Every column EXCEPT `id` and `code` — used for the UPDATE SET clause.
  SELECT string_agg(format('%I = EXCLUDED.%I', column_name, column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols_upd
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = p_table
     AND column_name NOT IN ('id', 'code');

  EXECUTE format(
    'INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_record(null::%I, $1) '||
    'ON CONFLICT (code) DO UPDATE SET %s '||
    'RETURNING to_jsonb(%I.*)',
    p_table, v_cols_ins, v_cols_ins, p_table, v_cols_upd, p_table
  ) INTO v_result USING p_row;
  RETURN v_result;
END $$;

-- Bulk upsert — one RPC call for an entire import batch. Returns number of
-- rows actually inserted or updated. Same identity-column handling as hwms_upsert.
CREATE OR REPLACE FUNCTION hwms_upsert_bulk(
  p_username TEXT, p_token TEXT, p_table TEXT, p_rows JSONB
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_cols_ins TEXT; v_cols_upd TEXT; v_count INT;
BEGIN
  PERFORM hwms_assert_session(p_username, p_token);
  PERFORM hwms_assert_access(p_username);
  PERFORM hwms_assert_table(p_table);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array' USING ERRCODE = '22004';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN RETURN 0; END IF;

  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols_ins
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = p_table
     AND column_name <> 'id';
  SELECT string_agg(format('%I = EXCLUDED.%I', column_name, column_name), ', ' ORDER BY ordinal_position)
    INTO v_cols_upd
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = p_table
     AND column_name NOT IN ('id', 'code');

  EXECUTE format(
    'INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_recordset(null::%I, $1) '||
    'ON CONFLICT (code) DO UPDATE SET %s',
    p_table, v_cols_ins, v_cols_ins, p_table, v_cols_upd
  ) USING p_rows;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Delete by `code`. Returns true if a row was actually removed.
CREATE OR REPLACE FUNCTION hwms_delete(
  p_username TEXT, p_token TEXT, p_table TEXT, p_code TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT;
BEGIN
  PERFORM hwms_assert_session(p_username, p_token);
  PERFORM hwms_assert_access(p_username);
  PERFORM hwms_assert_table(p_table);
  EXECUTE format('DELETE FROM %I WHERE code = $1', p_table)
    USING p_code;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END $$;

-- Incremental read — rows with updated_at > p_last_ts. If p_last_ts is NULL,
-- returns every row (same as hwms_read). If the table has no updated_at
-- column, falls back to a full read. Used by HWMS's incremental sync loop.
CREATE OR REPLACE FUNCTION hwms_read_since(
  p_username TEXT, p_token TEXT, p_table TEXT, p_last_ts TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB; v_has_ts BOOLEAN;
BEGIN
  PERFORM hwms_assert_session(p_username, p_token);
  PERFORM hwms_assert_access(p_username);
  PERFORM hwms_assert_table(p_table);
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=p_table AND column_name='updated_at'
  ) INTO v_has_ts;
  IF p_last_ts IS NULL OR NOT v_has_ts THEN
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), ''[]''::jsonb) FROM %I t', p_table
    ) INTO v_result;
  ELSE
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), ''[]''::jsonb) FROM %I t WHERE t.updated_at > $1',
      p_table
    ) INTO v_result USING p_last_ts;
  END IF;
  RETURN v_result;
END $$;

-- Date-range read — rows where p_col >= p_from AND p_col < p_to. Column is
-- whitelisted against information_schema to prevent injection. Used by
-- _loadOlderData when the user asks to expand the date window.
CREATE OR REPLACE FUNCTION hwms_read_date_range(
  p_username TEXT, p_token TEXT, p_table TEXT,
  p_col TEXT, p_from TEXT, p_to TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  PERFORM hwms_assert_session(p_username, p_token);
  PERFORM hwms_assert_access(p_username);
  PERFORM hwms_assert_table(p_table);
  IF NOT EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=p_table AND column_name=p_col
  ) THEN
    RAISE EXCEPTION 'Column % not found in %', p_col, p_table USING ERRCODE='42703';
  END IF;
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), ''[]''::jsonb) FROM %I t WHERE %I >= $1 AND %I < $2',
    p_table, p_col, p_col
  ) INTO v_result USING p_from, p_to;
  RETURN v_result;
END $$;

-- Selected-column read for a single row by code. Column names are
-- whitelisted against information_schema. Used for on-demand photo loading.
CREATE OR REPLACE FUNCTION hwms_read_cols_by_code(
  p_username TEXT, p_token TEXT, p_table TEXT, p_code TEXT, p_cols TEXT[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB; v_bad TEXT; v_col_list TEXT;
BEGIN
  PERFORM hwms_assert_session(p_username, p_token);
  PERFORM hwms_assert_access(p_username);
  PERFORM hwms_assert_table(p_table);
  IF p_cols IS NULL OR array_length(p_cols, 1) IS NULL THEN
    RAISE EXCEPTION 'p_cols must be a non-empty array' USING ERRCODE='22004';
  END IF;
  -- Reject any column not actually on the table
  SELECT c INTO v_bad FROM unnest(p_cols) AS c
   WHERE NOT EXISTS(
     SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=p_table AND column_name=c
   ) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'Column % not found in %', v_bad, p_table USING ERRCODE='42703';
  END IF;
  SELECT string_agg(format('%I', c), ', ') INTO v_col_list FROM unnest(p_cols) AS c;
  EXECUTE format(
    'SELECT to_jsonb(t) FROM (SELECT %s FROM %I WHERE code = $1 LIMIT 1) t',
    v_col_list, p_table
  ) INTO v_result USING p_code;
  RETURN v_result;
END $$;

-- Simple probe: does the table have an updated_at column? Used to decide
-- between incremental and full sync modes on the client.
CREATE OR REPLACE FUNCTION hwms_has_updated_at(
  p_username TEXT, p_token TEXT, p_table TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_has BOOLEAN;
BEGIN
  PERFORM hwms_assert_session(p_username, p_token);
  PERFORM hwms_assert_access(p_username);
  PERFORM hwms_assert_table(p_table);
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=p_table AND column_name='updated_at'
  ) INTO v_has;
  RETURN v_has;
END $$;

-- Grant EXECUTE to anon + authenticated so the browser anon-key client can
-- call the RPCs. The functions themselves gate on session_token, so only
-- logged-in users succeed.
GRANT EXECUTE ON FUNCTION hwms_assert_session(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_assert_access(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_assert_table(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_read(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_upsert(TEXT, TEXT, TEXT, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_upsert_bulk(TEXT, TEXT, TEXT, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_delete(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_read_since(TEXT, TEXT, TEXT, TIMESTAMPTZ) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_read_date_range(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_read_cols_by_code(TEXT, TEXT, TEXT, TEXT, TEXT[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hwms_has_updated_at(TEXT, TEXT, TEXT) TO anon, authenticated;

-- ========== PART 3 — TABLE LOCKDOWN (RUN ONLY AFTER CLIENT IS UPDATED) ==========
-- Enables RLS and revokes anon/authenticated grants on all HWMS tables.
-- After this runs, only the SECURITY DEFINER RPCs above (owned by postgres,
-- which bypasses RLS) can touch the data. PostgREST requests from the
-- browser anon key will return 401.
--
-- Uncomment and run ONCE client code has been deployed with RPC-based I/O.
/*
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hwms_parts','hwms_invoices','hwms_containers','hwms_hsn','hwms_uom',
    'hwms_packing','hwms_customers','hwms_port_discharge','hwms_port_loading',
    'hwms_carriers','hwms_company','hwms_steel_rates','hwms_sub_invoices',
    'hwms_material_requests','hwms_payment_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
  END LOOP;
END $$;
*/

-- ========== DONE ==========
-- Next: update common.js to route HWMS reads/writes through hwms_read,
-- hwms_upsert, hwms_upsert_bulk, hwms_delete. Then run PART 3.
