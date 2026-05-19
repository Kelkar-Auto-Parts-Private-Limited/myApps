-- ============================================================================
-- HRMS PII Lockdown (Phase 2c)
-- Hides 12 PII columns on `hrms_employees` from the anon key:
--   Banking     : acct_no, ifsc, bank_name, branch_name
--   Government  : aadhaar_no, pan_no, uan
--   Statutory   : esi_no, pf_no
--   Contact/DOB : mobile, email, date_of_birth
--
-- Approach: column-level GRANT/REVOKE (same shape as Phase 2a on vms_users.
-- password/session_token). The columns stay on the public table — anon's
-- SELECT grant on them is revoked, and a SECURITY DEFINER RPC returns the
-- locked columns for authenticated callers. PostgREST's anon-keyed `SELECT *`
-- would fail once the REVOKE lands; the client must switch to an explicit
-- non-PII column list AND lazy-load PII via `hrms_pii_read` (mirrors the
-- salary lockdown / shadow-write pattern).
--
-- DEPLOY ORDER
--   1. Run PART 1 (this file). Non-destructive. Creates the RPC + grants. No
--      REVOKE — `SELECT *` from anon still works. Safe to deploy on its own.
--   2. Update the client to:
--        - boot-select explicit non-PII columns from hrms_employees
--        - call hrms_pii_read after auth and merge PII into in-memory rows
--        - re-merge after every bgSync that touches hrms_employees
--        - strip PII keys from _toRow before save (defense-in-depth — the
--          column REVOKE in PART 2 will also block the write at the DB)
--      Redeploy the client and verify Employee modal / Salary Slip / Salary
--      Export / Statutory exports still display PII for authorized users.
--   3. Run PART 2 (REVOKE). Destructive in the sense that any anon-keyed
--      consumer still doing `SELECT *` will start receiving 42501 — the
--      client refactor in step 2 is a hard prerequisite. To roll back,
--      run the GRANT block at the bottom of PART 2.
-- ============================================================================

-- ========== PART 1 — RPC + GRANTS (non-destructive) ==========================

-- Bulk read. Returns every emp's PII as a JSONB array. Session is validated
-- via the existing hrms_assert_session (created by the salary lockdown);
-- after the salary `simplify` migration there is no client-side perm gate
-- here — any authenticated HRMS user can read PII. The UI-level gate
-- (`page.viewEmpPII` / role override) is enforced client-side so we can
-- adjust it without a DB migration.
CREATE OR REPLACE FUNCTION public.hrms_pii_read(p_username TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_result JSONB;
BEGIN
  PERFORM public.hrms_assert_session(p_username, p_token);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'emp_id',        e.code,
           'mobile',        e.mobile,
           'email',         e.email,
           'date_of_birth', e.date_of_birth,
           'aadhaar_no',    e.aadhaar_no,
           'pan_no',        e.pan_no,
           'uan',           e.uan,
           'esi_no',        e.esi_no,
           'pf_no',         e.pf_no,
           'bank_name',     e.bank_name,
           'branch_name',   e.branch_name,
           'acct_no',       e.acct_no,
           'ifsc',          e.ifsc
         )), '[]'::jsonb)
    INTO v_result
  FROM public.hrms_employees e;
  RETURN v_result;
END $fn$;

-- Single-row upsert for the PII columns. Used by the client when an
-- authorized user edits an employee's PII via the Employee modal. The
-- payload shape mirrors what `hrms_pii_read` returns. `emp_id` required;
-- missing keys are left untouched (NULL → no change).
CREATE OR REPLACE FUNCTION public.hrms_pii_upsert(
  p_username TEXT, p_token TEXT, p_row JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_emp TEXT; v_result JSONB;
BEGIN
  PERFORM public.hrms_assert_session(p_username, p_token);
  IF p_row IS NULL OR NOT (p_row ? 'emp_id') OR (p_row ->> 'emp_id') = '' THEN
    RAISE EXCEPTION '`emp_id` is required in payload' USING ERRCODE = '22004';
  END IF;
  v_emp := p_row ->> 'emp_id';

  UPDATE public.hrms_employees SET
    mobile        = COALESCE(p_row ->> 'mobile',        mobile),
    email         = COALESCE(p_row ->> 'email',         email),
    date_of_birth = COALESCE(p_row ->> 'date_of_birth', date_of_birth),
    aadhaar_no    = COALESCE(p_row ->> 'aadhaar_no',    aadhaar_no),
    pan_no        = COALESCE(p_row ->> 'pan_no',        pan_no),
    uan           = COALESCE(p_row ->> 'uan',           uan),
    esi_no        = COALESCE(p_row ->> 'esi_no',        esi_no),
    pf_no         = COALESCE(p_row ->> 'pf_no',         pf_no),
    bank_name     = COALESCE(p_row ->> 'bank_name',     bank_name),
    branch_name   = COALESCE(p_row ->> 'branch_name',   branch_name),
    acct_no       = COALESCE(p_row ->> 'acct_no',       acct_no),
    ifsc          = COALESCE(p_row ->> 'ifsc',          ifsc)
  WHERE code = v_emp
  RETURNING jsonb_build_object(
    'emp_id', code,
    'mobile', mobile, 'email', email, 'date_of_birth', date_of_birth,
    'aadhaar_no', aadhaar_no, 'pan_no', pan_no, 'uan', uan,
    'esi_no', esi_no, 'pf_no', pf_no,
    'bank_name', bank_name, 'branch_name', branch_name,
    'acct_no', acct_no, 'ifsc', ifsc
  ) INTO v_result;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Employee % not found', v_emp USING ERRCODE = '23503';
  END IF;
  RETURN v_result;
END $fn$;

GRANT EXECUTE ON FUNCTION public.hrms_pii_read(TEXT, TEXT)         TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hrms_pii_upsert(TEXT, TEXT, JSONB) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ========== PART 2 — REVOKE (destructive, run AFTER client refactor) ========
-- Uncomment and run only after the client has been redeployed to:
--   (a) boot-select explicit non-PII columns (no SELECT *)
--   (b) lazy-load PII via hrms_pii_read
--   (c) write PII via hrms_pii_upsert (or skip PII keys in _toRow)
--
-- REVOKE SELECT (mobile, email, date_of_birth, aadhaar_no, pan_no, uan,
--                esi_no, pf_no, bank_name, branch_name, acct_no, ifsc)
--   ON public.hrms_employees FROM anon, authenticated;
--
-- REVOKE UPDATE (mobile, email, date_of_birth, aadhaar_no, pan_no, uan,
--                esi_no, pf_no, bank_name, branch_name, acct_no, ifsc)
--   ON public.hrms_employees FROM anon, authenticated;
--
-- REVOKE INSERT (mobile, email, date_of_birth, aadhaar_no, pan_no, uan,
--                esi_no, pf_no, bank_name, branch_name, acct_no, ifsc)
--   ON public.hrms_employees FROM anon, authenticated;
--
-- NOTIFY pgrst, 'reload schema';

-- ========== ROLLBACK (PART 2) =================================================
-- Re-grants SELECT / INSERT / UPDATE on the PII columns to anon so the
-- pre-lockdown SELECT * path keeps working. RPCs stay in place — harmless.
--
-- GRANT SELECT, INSERT, UPDATE
--   (mobile, email, date_of_birth, aadhaar_no, pan_no, uan,
--    esi_no, pf_no, bank_name, branch_name, acct_no, ifsc)
--   ON public.hrms_employees TO anon, authenticated;
-- NOTIFY pgrst, 'reload schema';
