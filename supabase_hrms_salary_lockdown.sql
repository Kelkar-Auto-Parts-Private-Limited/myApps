-- ============================================================================
-- HRMS Salary Lockdown Migration
-- Moves salary fields (salary_day, salary_month, plus per-period and per-month
-- historical salary values) out of `hrms_employees` (which the anon key can
-- still read for everything else) into a new `hrms_employee_salary` table that
-- anon has NO direct grants on. Reads/writes go through SECURITY DEFINER RPCs
-- that validate the caller's session token AND require the new
-- `page.viewSalary` permission (or Super Admin / HRMS Admin override).
--
-- Modelled on supabase_hwms_lockdown.sql — same session-token gate (vms_users.
-- session_token) and same RPC shape (SECURITY DEFINER + RAISE EXCEPTION on
-- denial). The permission check additionally inspects the rolePermissions
-- record stored in hrms_settings.data.
--
-- WHAT GETS MOVED
--   1. hrms_employees.salary_day       → hrms_employee_salary.salary_day
--   2. hrms_employees.salary_month     → hrms_employee_salary.salary_month
--   3. periods[].salaryDay/Month/spAllow → salary_extras.periods[<index>]
--   4. extra.salaryMonths[mk].salaryDay/Month/spAllow → salary_extras.months[mk]
--
-- After the migration the public `hrms_employees` row carries ZERO salary
-- numbers — anyone with the anon key sees only zero/empty for those keys.
--
-- DEPLOY ORDER
--   1. Run PART 1 + PART 2 (create table + RPCs + grants). Safe to run on its
--      own — no data is moved yet, no existing behaviour breaks.
--   2. Update the client (V27) to route salary I/O through the new RPCs and
--      redeploy.
--   3. Verify Update Employee, Period Edit, Monthly Salary Edit, Save & Lock
--      Month, Salary Export and Slip PDF all still show the right numbers
--      to a Super Admin / page.viewSalary user, and show '—' to others.
--   4. Run PART 3 (one-shot migration) to copy salary rows into the new table
--      AND scrub them from hrms_employees JSONB + numeric columns. This is
--      the destructive step — back up first.
--   5. To roll back: PART 4 (commented) restores salary from
--      hrms_employee_salary back into hrms_employees and drops the new table.
-- ============================================================================

-- ========== PART 1 — HELPERS =================================================

-- Session validation — mirrors hwms_assert_session. Raises 28000 on failure.
CREATE OR REPLACE FUNCTION hrms_assert_session(p_username TEXT, p_token TEXT)
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

-- Salary-read access gate. Raises 42501 on denial. Three ways to pass:
--   (a) 'Super Admin' present in vms_users.roles
--   (b) 'HRMS Admin' present in vms_users.hrms_roles
--   (c) Any role in vms_users.hrms_roles maps to permissions[<role>]
--       ['page.viewSalary'] = true in the hrms_settings 'rolePermissions'
--       record (path: data -> 'HRMS' -> 'permissions' -> <role>).
CREATE OR REPLACE FUNCTION hrms_assert_view_salary(p_username TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_roles JSONB;
  v_user_hrms_roles JSONB;
  v_perms JSONB;
  v_role TEXT;
BEGIN
  SELECT u.roles, u.hrms_roles
    INTO v_user_roles, v_user_hrms_roles
  FROM vms_users u
  WHERE LOWER(u.name) = LOWER(p_username)
    AND (u.inactive IS NULL OR u.inactive = false);

  -- Super Admin (top-level role) — always full access.
  IF v_user_roles IS NOT NULL
     AND jsonb_typeof(v_user_roles) = 'array'
     AND v_user_roles ? 'Super Admin' THEN
    RETURN;
  END IF;

  -- HRMS Admin — module-admin override for HRMS.
  IF v_user_hrms_roles IS NOT NULL
     AND jsonb_typeof(v_user_hrms_roles) = 'array'
     AND v_user_hrms_roles ? 'HRMS Admin' THEN
    RETURN;
  END IF;

  -- Granular permission check — page.viewSalary must be true for at least
  -- one of the user's HRMS roles.
  SELECT s.data #> '{HRMS,permissions}'
    INTO v_perms
  FROM hrms_settings s
  WHERE s.key = 'rolePermissions'
  LIMIT 1;

  IF v_perms IS NOT NULL AND v_user_hrms_roles IS NOT NULL THEN
    FOR v_role IN SELECT jsonb_array_elements_text(v_user_hrms_roles) LOOP
      IF (v_perms -> v_role ->> 'page.viewSalary')::BOOLEAN IS TRUE THEN
        RETURN;
      END IF;
    END LOOP;
  END IF;

  RAISE EXCEPTION 'No salary access' USING ERRCODE = '42501';
END $$;

-- ========== PART 2 — TABLE + RPCs ============================================

-- One row per employee. `salary_extras` shape:
--   {
--     "periods": [ { "idx": <int>, "salaryDay": <num>, "salaryMonth": <num>, "specialAllowance": <num> }, ... ],
--     "months":  { "<YYYY-MM>": { "salaryDay": <num>, "salaryMonth": <num>, "specialAllowance": <num> }, ... }
--   }
-- The numeric top-level salary_day / salary_month carry the *current* values
-- (the head of the period chain). History lives in `salary_extras`.
CREATE TABLE IF NOT EXISTS hrms_employee_salary (
  emp_id        TEXT PRIMARY KEY,
  salary_day    NUMERIC NOT NULL DEFAULT 0,
  salary_month  NUMERIC NOT NULL DEFAULT 0,
  salary_extras JSONB   NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

-- Bulk read. Authorized callers get every salary row; unauthorized callers
-- get 42501. Returns a JSONB array of row objects.
CREATE OR REPLACE FUNCTION hrms_salary_read(p_username TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB;
BEGIN
  PERFORM hrms_assert_session(p_username, p_token);
  PERFORM hrms_assert_view_salary(p_username);
  SELECT COALESCE(jsonb_agg(to_jsonb(t.*)), '[]'::jsonb)
    INTO v_result
  FROM hrms_employee_salary t;
  RETURN v_result;
END $$;

-- Upsert one emp's salary row. Payload: { emp_id, salary_day, salary_month,
-- salary_extras }. emp_id is required; missing numeric fields default to 0,
-- missing salary_extras defaults to {}.
CREATE OR REPLACE FUNCTION hrms_salary_upsert(
  p_username TEXT, p_token TEXT, p_row JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_result JSONB; v_emp TEXT;
BEGIN
  PERFORM hrms_assert_session(p_username, p_token);
  PERFORM hrms_assert_view_salary(p_username);
  IF p_row IS NULL OR NOT (p_row ? 'emp_id') OR (p_row ->> 'emp_id') = '' THEN
    RAISE EXCEPTION '`emp_id` is required in payload' USING ERRCODE = '22004';
  END IF;
  v_emp := p_row ->> 'emp_id';
  INSERT INTO hrms_employee_salary (emp_id, salary_day, salary_month, salary_extras, updated_at, updated_by)
  VALUES (
    v_emp,
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
END $$;

-- Bulk upsert — for monthly snapshots / lock-month / import flows. Same gate
-- as the single-row version. Payload must be a JSON array.
CREATE OR REPLACE FUNCTION hrms_salary_upsert_bulk(
  p_username TEXT, p_token TEXT, p_rows JSONB
) RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT;
BEGIN
  PERFORM hrms_assert_session(p_username, p_token);
  PERFORM hrms_assert_view_salary(p_username);
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a JSON array' USING ERRCODE = '22004';
  END IF;
  IF jsonb_array_length(p_rows) = 0 THEN RETURN 0; END IF;

  INSERT INTO hrms_employee_salary (emp_id, salary_day, salary_month, salary_extras, updated_at, updated_by)
  SELECT
    r ->> 'emp_id',
    COALESCE((r ->> 'salary_day')::numeric, 0),
    COALESCE((r ->> 'salary_month')::numeric, 0),
    COALESCE(r -> 'salary_extras', '{}'::jsonb),
    now(),
    p_username
  FROM jsonb_array_elements(p_rows) AS r
  WHERE (r ->> 'emp_id') IS NOT NULL AND (r ->> 'emp_id') <> ''
  ON CONFLICT (emp_id) DO UPDATE SET
    salary_day    = EXCLUDED.salary_day,
    salary_month  = EXCLUDED.salary_month,
    salary_extras = EXCLUDED.salary_extras,
    updated_at    = now(),
    updated_by    = p_username;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- Delete by emp_id. Returns true if a row was removed.
CREATE OR REPLACE FUNCTION hrms_salary_delete(
  p_username TEXT, p_token TEXT, p_emp_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count INT;
BEGIN
  PERFORM hrms_assert_session(p_username, p_token);
  PERFORM hrms_assert_view_salary(p_username);
  DELETE FROM hrms_employee_salary WHERE emp_id = p_emp_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END $$;

-- Lock the new table from anon. Grants execute on the RPCs so the anon-keyed
-- client can still call them. RLS on the table is belt-and-braces — anon has
-- no grants anyway, but RLS makes the deny explicit if grants drift.
REVOKE ALL ON hrms_employee_salary FROM anon, authenticated;
ALTER TABLE hrms_employee_salary ENABLE ROW LEVEL SECURITY;
-- No policies defined = no rows visible to anyone except table-owner /
-- SECURITY DEFINER functions.

GRANT EXECUTE ON FUNCTION hrms_assert_session(TEXT, TEXT)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hrms_assert_view_salary(TEXT)          TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hrms_salary_read(TEXT, TEXT)           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hrms_salary_upsert(TEXT, TEXT, JSONB)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hrms_salary_upsert_bulk(TEXT, TEXT, JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION hrms_salary_delete(TEXT, TEXT, TEXT)   TO anon, authenticated;

-- ========== PART 3 — ONE-SHOT MIGRATION ======================================
-- ⚠ DESTRUCTIVE — copies salary into hrms_employee_salary, then strips it
--   from hrms_employees. Take a database backup first. Run only AFTER the
--   client has been updated to read salary through hrms_salary_read.
--
-- Uncomment the block below to execute.
--
-- DO $$
-- BEGIN
--   -- 3a. Copy salary into the new table. ON CONFLICT DO NOTHING so this is
--   --     idempotent — re-runs are safe.
--   INSERT INTO hrms_employee_salary (emp_id, salary_day, salary_month, salary_extras, updated_at)
--   SELECT
--     e.code AS emp_id,
--     COALESCE(e.salary_day, 0),
--     COALESCE(e.salary_month, 0),
--     jsonb_build_object(
--       'periods',
--         COALESCE(
--           (SELECT jsonb_agg(
--                     jsonb_strip_nulls(jsonb_build_object(
--                       'idx', i - 1,
--                       'salaryDay',        p -> 'salaryDay',
--                       'salaryMonth',      p -> 'salaryMonth',
--                       'specialAllowance', p -> 'specialAllowance'
--                     )))
--              FROM jsonb_array_elements(COALESCE(e.periods, '[]'::jsonb))
--                   WITH ORDINALITY AS arr(p, i)
--              WHERE p ? 'salaryDay' OR p ? 'salaryMonth' OR p ? 'specialAllowance'),
--           '[]'::jsonb),
--       'months',
--         COALESCE(
--           (SELECT jsonb_object_agg(k,
--                     jsonb_strip_nulls(jsonb_build_object(
--                       'salaryDay',        v -> 'salaryDay',
--                       'salaryMonth',      v -> 'salaryMonth',
--                       'specialAllowance', v -> 'specialAllowance'
--                     )))
--              FROM jsonb_each(COALESCE(e.extra -> 'salaryMonths', '{}'::jsonb)) AS x(k, v)
--              WHERE v ? 'salaryDay' OR v ? 'salaryMonth' OR v ? 'specialAllowance'),
--           '{}'::jsonb)
--     ),
--     now()
--   FROM hrms_employees e
--   ON CONFLICT (emp_id) DO NOTHING;
--
--   -- 3b. Zero the salary columns on hrms_employees.
--   UPDATE hrms_employees SET salary_day = 0, salary_month = 0;
--
--   -- 3c. Strip salary keys from each period in the periods JSONB array.
--   UPDATE hrms_employees
--   SET periods = COALESCE(
--     (SELECT jsonb_agg(p - 'salaryDay' - 'salaryMonth' - 'specialAllowance')
--      FROM jsonb_array_elements(periods) AS p),
--     '[]'::jsonb)
--   WHERE jsonb_typeof(periods) = 'array' AND jsonb_array_length(periods) > 0;
--
--   -- 3d. Strip salary keys from each month in extra.salaryMonths.
--   UPDATE hrms_employees
--   SET extra = jsonb_set(
--     extra,
--     '{salaryMonths}',
--     COALESCE(
--       (SELECT jsonb_object_agg(k, v - 'salaryDay' - 'salaryMonth' - 'specialAllowance')
--        FROM jsonb_each(extra -> 'salaryMonths') AS x(k, v)),
--       '{}'::jsonb))
--   WHERE extra ? 'salaryMonths';
-- END $$;

-- ========== PART 4 — ROLLBACK (do not run unless rolling back) ==============
-- Restores salary from hrms_employee_salary back into hrms_employees and
-- drops the new table + RPCs. Lossy if salary has been edited in the new
-- table since the migration (those edits are restored too — but anyone with
-- anon access now sees them again).
--
-- DO $$
-- BEGIN
--   -- Restore top-level salary.
--   UPDATE hrms_employees e
--   SET salary_day   = s.salary_day,
--       salary_month = s.salary_month
--   FROM hrms_employee_salary s
--   WHERE e.code = s.emp_id;
--
--   -- Restore per-period salary keys. Walk salary_extras.periods, find each
--   -- period by idx, merge salary keys back in.
--   UPDATE hrms_employees e
--   SET periods = (
--     SELECT jsonb_agg(
--       CASE
--         WHEN sp IS NULL THEN p
--         ELSE p || jsonb_strip_nulls(jsonb_build_object(
--           'salaryDay',        sp -> 'salaryDay',
--           'salaryMonth',      sp -> 'salaryMonth',
--           'specialAllowance', sp -> 'specialAllowance'
--         ))
--       END
--       ORDER BY i)
--     FROM jsonb_array_elements(e.periods) WITH ORDINALITY AS arr(p, i)
--     LEFT JOIN LATERAL (
--       SELECT x FROM jsonb_array_elements(s.salary_extras -> 'periods') AS x
--       WHERE (x ->> 'idx')::int = (i - 1)::int
--       LIMIT 1) AS l(sp) ON TRUE)
--   FROM hrms_employee_salary s
--   WHERE e.code = s.emp_id AND jsonb_typeof(e.periods) = 'array';
--
--   -- Restore per-month salary keys into extra.salaryMonths.
--   UPDATE hrms_employees e
--   SET extra = jsonb_set(
--     e.extra,
--     '{salaryMonths}',
--     COALESCE(
--       (SELECT jsonb_object_agg(
--                 k,
--                 COALESCE(em -> k, '{}'::jsonb) ||
--                 jsonb_strip_nulls(jsonb_build_object(
--                   'salaryDay',        v -> 'salaryDay',
--                   'salaryMonth',      v -> 'salaryMonth',
--                   'specialAllowance', v -> 'specialAllowance')))
--        FROM jsonb_each(s.salary_extras -> 'months') AS m(k, v),
--             LATERAL (SELECT COALESCE(e.extra -> 'salaryMonths', '{}'::jsonb)) AS em(em)),
--       e.extra -> 'salaryMonths'))
--   FROM hrms_employee_salary s
--   WHERE e.code = s.emp_id;
--
--   DROP FUNCTION IF EXISTS hrms_salary_delete(TEXT, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS hrms_salary_upsert_bulk(TEXT, TEXT, JSONB);
--   DROP FUNCTION IF EXISTS hrms_salary_upsert(TEXT, TEXT, JSONB);
--   DROP FUNCTION IF EXISTS hrms_salary_read(TEXT, TEXT);
--   DROP FUNCTION IF EXISTS hrms_assert_view_salary(TEXT);
--   -- Do NOT drop hrms_assert_session — it's used by future HRMS RPCs.
--   DROP TABLE IF EXISTS hrms_employee_salary;
-- END $$;
