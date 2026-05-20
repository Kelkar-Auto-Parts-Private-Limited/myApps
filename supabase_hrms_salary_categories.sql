-- ============================================================================
-- HRMS Salary — Category-aware access (Staff / Worker, View / Edit)
-- Replaces the single page.viewSalary gate with four granular permissions:
--   page.viewStaffSalary   — can SELECT salary rows for Staff emps
--   page.editStaffSalary   — can INSERT / UPDATE / DELETE Staff salary
--   page.viewWorkerSalary  — can SELECT salary rows for non-Staff emps
--   page.editWorkerSalary  — can INSERT / UPDATE / DELETE non-Staff salary
--
-- "Staff" = hrms_employees.category contains 'staff' (case-insensitive).
-- Everything else = "Worker".
-- Super Admin and HRMS Admin keep full access by override.
-- Edit implies View (an editor automatically sees what they can change).
--
-- Run all four CREATE OR REPLACE blocks in one go — they atomically swap the
-- old single-gate RPCs for the new category-aware versions. Safe to re-run.
-- ============================================================================

-- ── Resolve the caller's salary perms once, return as a JSONB record so the
-- ── downstream RPCs don't each repeat the role-walk.
CREATE OR REPLACE FUNCTION hrms_salary_perms_of(p_username TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_user_roles JSONB;
  v_user_hrms_roles JSONB;
  v_perms JSONB;
  v_role TEXT;
  v_role_perms JSONB;
  v_staff_view  BOOLEAN := FALSE;
  v_staff_edit  BOOLEAN := FALSE;
  v_worker_view BOOLEAN := FALSE;
  v_worker_edit BOOLEAN := FALSE;
BEGIN
  SELECT u.roles, u.hrms_roles
    INTO v_user_roles, v_user_hrms_roles
  FROM vms_users u
  WHERE LOWER(u.name) = LOWER(p_username)
    AND (u.inactive IS NULL OR u.inactive = FALSE);

  -- Super Admin (top-level) → full access.
  IF v_user_roles IS NOT NULL
     AND jsonb_typeof(v_user_roles) = 'array'
     AND v_user_roles ? 'Super Admin' THEN
    RETURN jsonb_build_object(
      'staff_view',  TRUE, 'staff_edit',  TRUE,
      'worker_view', TRUE, 'worker_edit', TRUE);
  END IF;

  -- HRMS Admin → module-admin override.
  IF v_user_hrms_roles IS NOT NULL
     AND jsonb_typeof(v_user_hrms_roles) = 'array'
     AND v_user_hrms_roles ? 'HRMS Admin' THEN
    RETURN jsonb_build_object(
      'staff_view',  TRUE, 'staff_edit',  TRUE,
      'worker_view', TRUE, 'worker_edit', TRUE);
  END IF;

  -- Walk each of the caller's HRMS roles and union the four flags. Edit
  -- implies view on the same category.
  SELECT s.data #> '{HRMS,permissions}' INTO v_perms
  FROM hrms_settings s
  WHERE s.key = 'rolePermissions'
  LIMIT 1;

  IF v_perms IS NOT NULL
     AND v_user_hrms_roles IS NOT NULL
     AND jsonb_typeof(v_user_hrms_roles) = 'array' THEN
    FOR v_role IN SELECT jsonb_array_elements_text(v_user_hrms_roles) LOOP
      v_role_perms := v_perms -> v_role;
      IF v_role_perms IS NULL THEN CONTINUE; END IF;
      IF (v_role_perms ->> 'page.viewStaffSalary')::BOOLEAN  IS TRUE THEN v_staff_view  := TRUE; END IF;
      IF (v_role_perms ->> 'page.editStaffSalary')::BOOLEAN  IS TRUE THEN v_staff_edit  := TRUE; v_staff_view  := TRUE; END IF;
      IF (v_role_perms ->> 'page.viewWorkerSalary')::BOOLEAN IS TRUE THEN v_worker_view := TRUE; END IF;
      IF (v_role_perms ->> 'page.editWorkerSalary')::BOOLEAN IS TRUE THEN v_worker_edit := TRUE; v_worker_view := TRUE; END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'staff_view',  v_staff_view,  'staff_edit',  v_staff_edit,
    'worker_view', v_worker_view, 'worker_edit', v_worker_edit);
END $fn$;

GRANT EXECUTE ON FUNCTION hrms_salary_perms_of(TEXT) TO anon, authenticated;

-- ── Bulk read — returns the salary rows whose emp.category matches a
--    view-granted permission. Raises 42501 if caller has NEITHER view perm.
CREATE OR REPLACE FUNCTION hrms_salary_read(p_username TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_perms JSONB;
  v_result JSONB;
BEGIN
  PERFORM hrms_assert_session(p_username, p_token);
  v_perms := hrms_salary_perms_of(p_username);
  IF NOT ((v_perms ->> 'staff_view')::BOOLEAN OR (v_perms ->> 'worker_view')::BOOLEAN) THEN
    RAISE EXCEPTION 'No salary access' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb)
    INTO v_result
  FROM hrms_employee_salary t
  JOIN hrms_employees e ON e.code = t.emp_id
  WHERE
    (POSITION('staff' IN LOWER(COALESCE(e.category, ''))) > 0
       AND (v_perms ->> 'staff_view')::BOOLEAN)
    OR
    (POSITION('staff' IN LOWER(COALESCE(e.category, ''))) = 0
       AND (v_perms ->> 'worker_view')::BOOLEAN);
  RETURN v_result;
END $fn$;

-- ── Single-row upsert — needs the caller's edit perm for that emp's
--    category. Staff emp → page.editStaffSalary; everyone else →
--    page.editWorkerSalary. Returns the persisted row.
CREATE OR REPLACE FUNCTION hrms_salary_upsert(
  p_username TEXT, p_token TEXT, p_row JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_perms JSONB;
  v_emp_id TEXT;
  v_is_staff BOOLEAN;
  v_allowed BOOLEAN;
  v_result JSONB;
BEGIN
  PERFORM hrms_assert_session(p_username, p_token);
  v_perms := hrms_salary_perms_of(p_username);
  IF p_row IS NULL OR NOT (p_row ? 'emp_id') OR (p_row ->> 'emp_id') = '' THEN
    RAISE EXCEPTION '`emp_id` is required in payload' USING ERRCODE = '22004';
  END IF;
  v_emp_id := p_row ->> 'emp_id';

  SELECT POSITION('staff' IN LOWER(COALESCE(e.category, ''))) > 0
    INTO v_is_staff
  FROM hrms_employees e
  WHERE e.code = v_emp_id;
  IF v_is_staff IS NULL THEN
    RAISE EXCEPTION 'Employee % not found', v_emp_id USING ERRCODE = '23503';
  END IF;

  v_allowed := CASE
    WHEN v_is_staff THEN (v_perms ->> 'staff_edit')::BOOLEAN
    ELSE                  (v_perms ->> 'worker_edit')::BOOLEAN
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'No salary edit access for this employee category'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO hrms_employee_salary (emp_id, salary_day, salary_month, salary_extras, updated_at, updated_by)
  VALUES (
    v_emp_id,
    COALESCE((p_row ->> 'salary_day')::numeric, 0),
    COALESCE((p_row ->> 'salary_month')::numeric, 0),
    COALESCE(p_row -> 'salary_extras', '{}'::jsonb),
    now(),
    p_username
  )
  ON CONFLICT (emp_id) DO UPDATE SET
    salary_day    = EXCLUDED.salary_day,
    salary_month  = EXCLUDED.salary_month,
    salary_extras = EXCLUDED.salary_extras,
    updated_at    = now(),
    updated_by    = p_username
  RETURNING to_jsonb(hrms_employee_salary.*) INTO v_result;
  RETURN v_result;
END $fn$;

-- ── Bulk upsert — silently skips rows whose emp category falls outside the
--    caller's edit perm. Caller can fail-fast by checking the returned count
--    against jsonb_array_length(p_rows).
CREATE OR REPLACE FUNCTION hrms_salary_upsert_bulk(
  p_username TEXT, p_token TEXT, p_rows JSONB
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_perms JSONB;
  v_count INT;
BEGIN
  PERFORM hrms_assert_session(p_username, p_token);
  v_perms := hrms_salary_perms_of(p_username);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array' USING ERRCODE = '22004';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN RETURN 0; END IF;
  IF NOT ((v_perms ->> 'staff_edit')::BOOLEAN OR (v_perms ->> 'worker_edit')::BOOLEAN) THEN
    RAISE EXCEPTION 'No salary edit access' USING ERRCODE = '42501';
  END IF;

  INSERT INTO hrms_employee_salary (emp_id, salary_day, salary_month, salary_extras, updated_at, updated_by)
  SELECT
    r ->> 'emp_id',
    COALESCE((r ->> 'salary_day')::numeric, 0),
    COALESCE((r ->> 'salary_month')::numeric, 0),
    COALESCE(r -> 'salary_extras', '{}'::jsonb),
    now(),
    p_username
  FROM jsonb_array_elements(p_rows) AS r
  JOIN hrms_employees e ON e.code = (r ->> 'emp_id')
  WHERE (r ->> 'emp_id') IS NOT NULL
    AND (r ->> 'emp_id') <> ''
    AND (
      (POSITION('staff' IN LOWER(COALESCE(e.category, ''))) > 0
         AND (v_perms ->> 'staff_edit')::BOOLEAN)
      OR
      (POSITION('staff' IN LOWER(COALESCE(e.category, ''))) = 0
         AND (v_perms ->> 'worker_edit')::BOOLEAN)
    )
  ON CONFLICT (emp_id) DO UPDATE SET
    salary_day    = EXCLUDED.salary_day,
    salary_month  = EXCLUDED.salary_month,
    salary_extras = EXCLUDED.salary_extras,
    updated_at    = now(),
    updated_by    = p_username;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $fn$;

-- ── Delete by emp_id — needs edit perm matching the emp's category. If the
--    emp record has already been removed (orphan salary row), allow the
--    delete only when the caller has *some* edit perm.
CREATE OR REPLACE FUNCTION hrms_salary_delete(
  p_username TEXT, p_token TEXT, p_emp_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_perms JSONB;
  v_is_staff BOOLEAN;
  v_allowed BOOLEAN;
  v_count INT;
BEGIN
  PERFORM hrms_assert_session(p_username, p_token);
  v_perms := hrms_salary_perms_of(p_username);

  SELECT POSITION('staff' IN LOWER(COALESCE(e.category, ''))) > 0
    INTO v_is_staff
  FROM hrms_employees e
  WHERE e.code = p_emp_id;

  v_allowed := CASE
    WHEN v_is_staff IS NULL THEN
      (v_perms ->> 'staff_edit')::BOOLEAN OR (v_perms ->> 'worker_edit')::BOOLEAN
    WHEN v_is_staff THEN
      (v_perms ->> 'staff_edit')::BOOLEAN
    ELSE
      (v_perms ->> 'worker_edit')::BOOLEAN
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'No salary delete access for this employee category'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM hrms_employee_salary WHERE emp_id = p_emp_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END $fn$;
