# MyApps Refactoring Todo

## Approach
- Work app by app, smallest to largest: Security → HRMS → Portal → VMS → HWMS
- Complete all phases for each app before moving to next
- Test after each phase, commit after each completed phase per app
- No feature changes — only structural refactoring

---

## Phase 0: Rename Files (Do first — one-time)

### 0.1 Rename HTML files
- [x] `myApps_VMS.html` → `vms.html`
- [x] `myApps_HRMS.html` → `hrms.html`
- [x] `myApps_HWMS.html` → `hwms.html`
- [x] `myApps_Security.html` → `security.html`
- [x] `myApps_Common.js` → `js/common.js`

### 0.2 Update all internal references
- [x] Update `_navigateTo()` URLs in all files
- [x] Update `<script src="myApps_Common.js">` in all HTML files
- [x] Update any `window.location.href` references
- [x] No GitHub Pages links found

### 0.3 Verify
- [ ] Test all navigation: Portal → VMS → HRMS → HWMS → Security → Portal
- [ ] Test login/session across all apps
- [ ] Commit and push

---

## Phase 1: Extract CSS into separate files

### 1.1 Common CSS
- [x] Extract styles from `<style>` blocks into per-app CSS files
- [ ] Create `css/common.css` (deferred to Phase 4 — styles vary per app, dedup needed first)
- [x] Replace `<style>` blocks in all HTML files with `<link>` to CSS files
- [ ] Convert frequently-used inline `style=` attributes to CSS classes

### 1.2 App-specific CSS (per app)
- [x] Security: Extract app-specific styles → `css/security.css` (597 lines)
- [x] HRMS: Extract app-specific styles → `css/hrms.css` (41 lines)
- [x] Portal: Extract login/portal styles → `css/portal.css` (67 lines)
- [x] VMS: Extract app-specific styles → `css/vms.css` (561 lines)
- [x] HWMS: Extract app-specific styles → `css/hwms.css` (224 lines)

---

## Phase 2: Extract JavaScript into separate files

### 2.1 Common JS cleanup
- [ ] Review `js/common.js` — add section comments, organize by concern (deferred to Phase 5)
- [ ] Group: Auth helpers, DB operations, UI utilities, Session management, Sync engine

### 2.2 App JS extraction (per app)
- [x] Security: Move `<script>` contents → `js/security.js` (406 lines), HTML template-only (220 lines)
- [x] HRMS: Move `<script>` contents → `js/hrms.js` (4,189 lines), HTML template-only (473 lines)
- [x] Portal: Move `<script>` contents → `js/portal.js` (1,265 lines), HTML template-only (310 lines)
- [x] VMS: Move `<script>` contents → `js/vms.js` (8,824 lines), HTML template-only (1,199 lines)
- [x] HWMS: Move `<script>` contents → `js/hwms.js` (14,802 lines), HTML template-only (1,220 lines)

---

## Phase 3: Separate UI layer and Business logic

### 3.1 Define patterns
- [x] Logic files contain pure functions (no DOM): calculations, validation, data filtering, status derivation
- [x] UI files contain DOM rendering, event handlers, modal population, navigation
- [x] Load order: common.js → app-logic.js → app-ui.js

### 3.2 Per app separation
- [x] Security: `security-logic.js` (9 lines, 2 funcs) + `security-ui.js` (405 lines)
- [x] HRMS: `hrms-logic.js` (270 lines, 25 funcs: salary/PL/PT calc, time parsing, date utils) + `hrms-ui.js` (3,983 lines)
- [x] Portal: `portal-logic.js` (43 lines: sync config, date filter, password validation, lockout) + `portal-ui.js` (1,236 lines)
- [x] VMS: `vms-logic.js` (361 lines, 20 funcs: trip workflow, segment steps, report data) + `vms-ui.js` (8,512 lines)
- [x] HWMS: `hwms-logic.js` (491 lines, 33 funcs: invoice/payment calc, container status, MR status) + `hwms-ui.js` (14,345 lines)

---

## Phase 4: Write Tests

### 4.1 Test infrastructure
- [x] Set up test runner: `tests/test-runner.html` (open in browser, no server needed)
- [x] Create `tests/` directory
- [x] Create test helper: `tests/test-helpers.js` (mini framework + DB/CU/byId mocks)

### 4.2 Common logic tests
- [ ] Auth: `_authLogin`, `_authVerifySession`, `_authChangePassword` (deferred — tightly coupled to Supabase)
- [ ] Data: `_toRow`, `_fromRow` (deferred — in common.js, not yet split)
- [ ] Utils: `uid()`, `byId()` are mocked in test-helpers.js

### 4.3 HRMS business logic tests (58 tests in test-hrms-logic.js)
- [x] PL calculation: `_hrmsCalcPLGiven`, `_hrmsCumPLAvail`, `_hrmsGetConfirmationDate`
- [x] Months since confirmation: `_hrmsMonthsSinceConfirmation` (rounding, edge cases)
- [x] PT calculation: `_hrmsCalcPT` (thresholds, female exemption, Feb surcharge)
- [x] Day type lookup: `_hrmsGetDayType` per plant
- [x] Time parsing/rounding: `_hrmsParseTime`, `_hrmsRoundIn`, `_hrmsRoundOut`
- [x] Date/period helpers: `_hrmsMonthLabel`, `_hrmsCurMonth`, `_hrmsPrevMonth`, `_hrmsFYStart`, `_hrmsFmtDate`

### 4.4 VMS business logic tests (79 tests in test-vms-logic.js)
- [x] Trip workflow: `buildSegment`, `recalcSegSteps`, `nextStep`
- [x] Step checks: `allStepsDone`, `stepsOneAndTwoDone`, `stepsUpTo3Done`
- [x] Status: `tripOverallStatus`, `getCriteria`, `getTripCatId`
- [x] Reports: `getReportData`, `rptRow`
- [x] ID generation: `genTripId`, `_tripIdPrefix`
- [x] Sync: `_syncSelect`, `_syncMergeRows`, `_stripStepPhotos`
- [x] Auth: `_isStrongPwd`

### 4.5 HWMS business logic tests (102 tests in test-hwms-logic.js)
- [x] Invoice status: `_hwmsInvStatus`, `_hwmsMiSt`, `_hwmsSiAggSt`, `_hwmsSiStatus`
- [x] Container status: `_hwmsContainerSt`, `_hwmsContStatus`, `_hwmsContGetType`
- [x] Payment: `_hwmsPayCalc`, `_hwmsPayAggSt`, `_hwmsContPaySt` + all accessors
- [x] MR: `_hwmsMrCalcStatus`, `_hwmsMrDispatchInfo`
- [x] Data utils: `_xlSerialToISO`, `_fixExcelDate`, `_hwmsCurrencyParse`, `_hwmsAmtToWords`
- [x] Part/pallet: `_hwmsPartPalletStatus`, `_hwmsContNumToSortVal`

---

## Phase 5: Code Optimization

### 5.1 Dead code removal
- [x] Scanned all JS files for unused functions — none found (all functions have references)
- [x] Removed 189-line legacy PLI card code in `hwms-ui.js` (dead code behind `_skipLegacyCards` guard)
- [ ] Remove unused CSS classes (deferred — requires runtime analysis)

### 5.2 Consolidate duplicates
- [x] Moved `_isStrongPwd` to common.js (was in portal-logic.js + vms-logic.js)
- [x] Moved `_syncSelect`, `_dateCutoff`, `_applyDateFilter` to common.js (was in portal-logic.js + vms-logic.js + hwms-ui.js + vms-ui.js)
- [x] Each app keeps its own `_SYNC_SELECT`, `_DATE_FILTER_DAYS`, `_DATE_FILTER_COL` config (different per app)
- [ ] Password UI functions (_liveValidatePwd, _openForcePassModal, etc.) duplicated in portal-ui + vms-ui — deferred (subtle differences, app-specific variables)

### 5.3 Performance
- [ ] Reduce unnecessary DOM rebuilds (deferred — requires per-app profiling)
- [ ] Optimize large list rendering (deferred — virtual scrolling is a feature addition)
- [ ] Lazy-load heavy components (deferred — PDF/XLSX are only loaded on demand already)

---

## Phase 6: Code Beautification

### 6.1 Naming conventions
- [x] Already consistent: camelCase functions, `_` prefix for internal, UPPER_SNAKE for constants
- [ ] DOM IDs normalization (deferred — would break HTML onclick references)

### 6.2 Documentation
- [x] File-level `@file` JSDoc headers on all 10 JS files (5 logic + 5 UI)
- [x] JSDoc `@param`/`@returns` on all logic file functions (80+ functions documented)
- [x] Section separator comments (`// ═══ SECTION NAME ═══`) in all UI files:
  - security-ui: 5 sections | portal-ui: 9 | hrms-ui: 20 | vms-ui: 25 | hwms-ui: 24
- [ ] Document complex business rules inline (deferred — requires domain expertise review)

### 6.3 Formatting
- [ ] Consistent indentation (deferred — 32k lines, high risk of breaking minified code)
- [x] Related functions grouped together via section separators
- [ ] Line length normalization (deferred — would require full reformat)

---

## Phase 7: Documentation (HTML)

### 7.1 Product Requirements Document — `docs/prd.html` (656 lines)
- [x] App overview and purpose (Portal, VMS, HRMS, HWMS, Security)
- [x] Feature list per app with target users
- [x] User roles and permissions matrix (3 tables: VMS, HRMS, HWMS roles)
- [x] Data model: 28+ Supabase tables with key columns and relationships
- [x] Integration points (Supabase, GitHub Pages, offline-first, security)

### 7.2 User Stories — `docs/user-stories.html` (829 lines, 61 stories)
- [x] Portal: 10 stories (auth, profile, user mgmt, storage)
- [x] VMS: 15 stories (trips, gate ops, MR, approvals, spot, masters, rates)
- [x] HRMS: 14 stories (employees, attendance, salary, PL, masters, print)
- [x] HWMS: 14 stories (containers, invoices, MR, parts, payments, dashboard)
- [x] Security: 8 stories (checkpoints, guards, round schedules)

### 7.3 Architecture Document — `docs/architecture.html` (1,003 lines)
- [x] System overview (static site + Supabase backend)
- [x] File structure (24 files with descriptions)
- [x] Module dependencies (4-script load order per page)
- [x] Database schema (28 tables with columns, organized by module)
- [x] Authentication flow (5 RPC functions, session restore, password policy)
- [x] Sync architecture (boot, hot poll, full sync, realtime, visibility API)
- [x] Data flow (write/delete/read/bulk paths, client-server diagrams)

### 7.4 Training Documents (5 HTML guides)
- [x] `training-admin.html` — Super Admin/Admin: user mgmt, all apps, masters, storage
- [x] `training-vms.html` — Per-role: Trip Booking, KAP Security, Material Receiver, Approver, Plant Head
- [x] `training-hrms.html` — Employees, attendance, salary, statutory, print, masters
- [x] `training-hwms.html` — Containers, invoices, sub-invoices, MR, parts, payments, dashboard
- [x] `training-vendor.html` — Assigned trips, status tracking, vehicle/driver info, FAQ

---

## Target File Structure (end state)
```
MyApps/
├── index.html                  (Portal HTML template)
├── vms.html                    (VMS HTML template)
├── hrms.html                   (HRMS HTML template)
├── hwms.html                   (HWMS HTML template)
├── security.html               (Security HTML template)
├── css/
│   ├── common.css              (Shared styles)
│   ├── portal.css
│   ├── vms.css
│   ├── hrms.css
│   ├── hwms.css
│   └── security.css
├── js/
│   ├── common.js               (Shared: auth, DB, sync, utils)
│   ├── portal-ui.js
│   ├── portal-logic.js
│   ├── vms-ui.js
│   ├── vms-logic.js
│   ├── hrms-ui.js
│   ├── hrms-logic.js
│   ├── hwms-ui.js
│   ├── hwms-logic.js
│   ├── security-ui.js
│   └── security-logic.js
├── tests/
│   ├── test-runner.html        (Open in browser to run tests)
│   ├── test-common.js
│   ├── test-hrms-logic.js
│   ├── test-vms-logic.js
│   └── test-hwms-logic.js
├── docs/
│   ├── prd.html                (Product Requirements Document)
│   ├── user-stories.html       (User stories — all apps)
│   ├── architecture.html       (System architecture & data model)
│   ├── training-admin.html     (Training: Super Admin / Admin)
│   ├── training-plant-head.html (Training: Plant Head)
│   ├── training-trip-booking.html (Training: Trip Booking User)
│   ├── training-kap-security.html (Training: KAP Security Gate)
│   ├── training-material.html  (Training: Material Receiver)
│   ├── training-approver.html  (Training: Trip Approver)
│   ├── training-hrms.html      (Training: HRMS Users)
│   ├── training-hwms.html      (Training: HWMS Users)
│   └── training-vendor.html    (Training: Vendor Users)
└── supabase_auth_migration.sql
```
