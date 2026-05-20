-- Migration: Create hrms_month_data table
-- One row per employee per month — fully self-contained.
-- When a month is "saved & locked", all tabs render from this table only.
-- No dependency on hrms_employees, hrms_attendance, hrms_settings, etc.

CREATE TABLE IF NOT EXISTS hrms_month_data (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,       -- app ID: 'hmd_2026-01_EMP001'
  month_key       TEXT NOT NULL,              -- 'YYYY-MM'
  emp_code        TEXT NOT NULL,              -- employee code (or '_meta' for month-level settings)

  -- ── Employee Master Snapshot ──
  name            TEXT DEFAULT '',
  first_name      TEXT DEFAULT '',
  last_name       TEXT DEFAULT '',
  middle_name     TEXT DEFAULT '',
  location        TEXT DEFAULT '',            -- plant
  category        TEXT DEFAULT '',            -- Worker / Staff
  department      TEXT DEFAULT '',
  sub_department  TEXT DEFAULT '',
  designation     TEXT DEFAULT '',
  employment_type TEXT DEFAULT '',            -- On Roll / Contract / Piece Rate
  date_of_joining TEXT DEFAULT '',
  date_of_birth   TEXT DEFAULT '',
  gender          TEXT DEFAULT '',
  status          TEXT DEFAULT 'Active',
  team_name       TEXT DEFAULT '',
  roll            TEXT DEFAULT '',
  no_pl           BOOLEAN DEFAULT FALSE,
  esi_no          TEXT DEFAULT '',
  pf_no           TEXT DEFAULT '',
  uan             TEXT DEFAULT '',
  pan_no          TEXT DEFAULT '',
  aadhaar_no      TEXT DEFAULT '',

  -- ── Bank Details (Payments tab) ──
  bank_name       TEXT DEFAULT '',
  branch_name     TEXT DEFAULT '',
  acct_no         TEXT DEFAULT '',
  ifsc            TEXT DEFAULT '',

  -- ── Salary Period ──
  rate_d          NUMERIC DEFAULT 0,          -- salary per day
  rate_m          NUMERIC DEFAULT 0,          -- salary per month
  sp_allow        NUMERIC DEFAULT 0,          -- special allowance (TA)

  -- ── Attendance (JSONB — dynamic daily data) ──
  attendance      JSONB DEFAULT '{}',         -- {"1":{"in":"08:00","out":"17:00"}, ...}
  alterations     JSONB DEFAULT '{}',         -- {"5":{"in":"09:00","out":"17:30","reason":"..."}}
  day_types       JSONB DEFAULT '{}',         -- {"1":"WD","2":"WD","7":"WO","15":"PH"}

  -- ── Computed Attendance Totals ──
  wd_count        NUMERIC DEFAULT 0,          -- working days
  ph_count        NUMERIC DEFAULT 0,          -- paid holidays
  total_p         NUMERIC DEFAULT 0,          -- present days
  total_a         NUMERIC DEFAULT 0,          -- absent days
  total_ot        NUMERIC DEFAULT 0,          -- overtime hours
  total_ots       NUMERIC DEFAULT 0,          -- Sunday/holiday OT hours
  total_pl        NUMERIC DEFAULT 0,          -- paid leave days (PL given + PH)
  paid_absent     NUMERIC DEFAULT 0,          -- absent after PL

  -- ── Manual Overrides Applied ──
  manual_p        NUMERIC,                    -- NULL = auto, else manual present days
  manual_pl       NUMERIC,                    -- NULL = auto, else manual PL
  manual_ot       NUMERIC,                    -- NULL = auto
  manual_ots      NUMERIC,                    -- NULL = auto
  tds             NUMERIC DEFAULT 0,

  -- ── Paid Leave ──
  pl_ob           NUMERIC DEFAULT 0,
  pl_given        NUMERIC DEFAULT 0,
  pl_cb           NUMERIC DEFAULT 0,
  pl_avail        NUMERIC DEFAULT 0,
  conf_months     NUMERIC DEFAULT 0,          -- months since confirmation
  fy_month_no     NUMERIC DEFAULT 0,          -- FY month (Apr=1 ... Mar=12)

  -- ── Effective OT ──
  ot_at1          NUMERIC DEFAULT 0,          -- IOT hours @1x
  ot_at15         NUMERIC DEFAULT 0,          -- OT hours @1.5x
  ot_at2          NUMERIC DEFAULT 0,          -- OTS hours @2x

  -- ── Salary Breakdown ──
  sal_for_p       NUMERIC DEFAULT 0,          -- salary for present days
  sal_ab          NUMERIC DEFAULT 0,          -- attendance bonus
  sal_for_pl      NUMERIC DEFAULT 0,          -- salary for paid leave
  sal_ot1         NUMERIC DEFAULT 0,          -- OT @1x amount
  sal_ot15        NUMERIC DEFAULT 0,          -- OT @1.5x amount
  sal_ot2         NUMERIC DEFAULT 0,          -- OT @2x amount
  allowance       NUMERIC DEFAULT 0,          -- transport/special allowance
  gross           NUMERIC DEFAULT 0,

  -- ── Advance ──
  adv_ob          NUMERIC DEFAULT 0,
  adv_month       NUMERIC DEFAULT 0,
  adv_ded         NUMERIC DEFAULT 0,
  adv_cb          NUMERIC DEFAULT 0,

  -- ── Deductions ──
  ded_pt          NUMERIC DEFAULT 0,
  ded_pf          NUMERIC DEFAULT 0,
  ded_esi         NUMERIC DEFAULT 0,
  ded_adv         NUMERIC DEFAULT 0,
  ded_tds         NUMERIC DEFAULT 0,
  ded_other       NUMERIC DEFAULT 0,
  ded_total       NUMERIC DEFAULT 0,

  -- ── Net ──
  net             NUMERIC DEFAULT 0,

  -- ── Month-level metadata (only for _meta row) ──
  meta            JSONB DEFAULT '{}'          -- {savedAt, savedBy, empCount, statutory:{...}, calendar:[...]}
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_hmd_month ON hrms_month_data (month_key);
CREATE INDEX IF NOT EXISTS idx_hmd_emp   ON hrms_month_data (month_key, emp_code);

-- Enable realtime
ALTER TABLE hrms_month_data REPLICA IDENTITY FULL;
