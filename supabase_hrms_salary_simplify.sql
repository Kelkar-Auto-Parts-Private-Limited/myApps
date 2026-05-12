-- ============================================================================
-- HRMS Salary — Simplify role gating
-- The fine-grained "hide sal/mon + Sp Allow for On-Roll Staff" rule lives at
-- UI level (salary.viewOnRollStaffDetails permission). At the RPC level any
-- authenticated user can read/write salary — the DB-level lockdown still
-- blocks the anon key, which is the actual protection we care about.
--
-- Safe to re-run. Just rewrites hrms_salary_perms_of; the four RPCs that
-- depend on it (read / upsert / upsert_bulk / delete) keep their existing
-- bodies and inherit the new always-allow result.
-- ============================================================================

CREATE OR REPLACE FUNCTION hrms_salary_perms_of(p_username TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- Caller's session is already validated by hrms_assert_session before this
  -- runs. Any authenticated HRMS user can read/write salary via the RPC; the
  -- "mask sal/mon + Sp Allow for On-Roll Staff" gate is enforced client-side
  -- by the salary.viewOnRollStaffDetails permission.
  RETURN jsonb_build_object(
    'staff_view',  TRUE, 'staff_edit',  TRUE,
    'worker_view', TRUE, 'worker_edit', TRUE);
END $fn$;

GRANT EXECUTE ON FUNCTION hrms_salary_perms_of(TEXT) TO anon, authenticated;
