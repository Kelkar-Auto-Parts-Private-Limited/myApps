# MyApps Refactoring Todo

## Approach
- Work app by app, smallest to largest: Security → HRMS → Portal → VMS → HWMS
- Complete all phases for each app before moving to next
- Test after each phase, commit after each completed phase per app
- No feature changes — only structural refactoring

---

## Phase 0: Rename Files (Do first — one-time)

### 0.1 Rename HTML files
- [ ] `myApps_VMS.html` → `vms.html`
- [ ] `myApps_HRMS.html` → `hrms.html`
- [ ] `myApps_HWMS.html` → `hwms.html`
- [ ] `myApps_Security.html` → `security.html`
- [ ] `myApps_Common.js` → `js/common.js`

### 0.2 Update all internal references
- [ ] Update `_navigateTo()` URLs in all files
- [ ] Update `<script src="myApps_Common.js">` in all HTML files
- [ ] Update any `window.location.href` references
- [ ] Update GitHub Pages links if any

### 0.3 Verify
- [ ] Test all navigation: Portal → VMS → HRMS → HWMS → Security → Portal
- [ ] Test login/session across all apps
- [ ] Commit and push

---

## Phase 1: Extract CSS into separate files

### 1.1 Common CSS
- [ ] Extract shared styles from `<style>` blocks (sidebar, topbar, cards, modals, buttons, forms, tables, badges, spinners)
- [ ] Create `css/common.css`
- [ ] Replace `<style>` blocks in all HTML files with `<link>` to common.css
- [ ] Convert frequently-used inline `style=` attributes to CSS classes

### 1.2 App-specific CSS (per app)
- [ ] Security: Extract app-specific styles → `css/security.css`
- [ ] HRMS: Extract app-specific styles → `css/hrms.css`
- [ ] Portal: Extract login/portal styles → `css/portal.css`
- [ ] VMS: Extract app-specific styles → `css/vms.css`
- [ ] HWMS: Extract app-specific styles → `css/hwms.css`

---

## Phase 2: Extract JavaScript into separate files

### 2.1 Common JS cleanup
- [ ] Review `js/common.js` — add section comments, organize by concern
- [ ] Group: Auth helpers, DB operations, UI utilities, Session management, Sync engine

### 2.2 App JS extraction (per app)
- [ ] Security: Move `<script>` contents → `js/security.js`, HTML becomes template-only
- [ ] HRMS: Move `<script>` contents → `js/hrms.js`
- [ ] Portal: Move `<script>` contents → `js/portal.js`
- [ ] VMS: Move `<script>` contents → `js/vms.js`
- [ ] HWMS: Move `<script>` contents → `js/hwms.js`

---

## Phase 3: Separate UI layer and Business logic

### 3.1 Define patterns
- [ ] Define naming convention: `renderXxx()` for UI, `calcXxx()` for logic, `dbXxx()` for data
- [ ] Define module structure per app

### 3.2 Per app separation
- [ ] Security: Split into `js/security-ui.js` + `js/security-logic.js`
- [ ] HRMS: Split into `js/hrms-ui.js` + `js/hrms-logic.js`
- [ ] Portal: Split into `js/portal-ui.js` + `js/portal-logic.js`
- [ ] VMS: Split into `js/vms-ui.js` + `js/vms-logic.js`
- [ ] HWMS: Split into `js/hwms-ui.js` + `js/hwms-logic.js`

---

## Phase 4: Write Tests

### 4.1 Test infrastructure
- [ ] Set up test runner (plain HTML test page or lightweight framework like uvu/tape)
- [ ] Create `tests/` directory
- [ ] Create test helper to mock DB/Supabase calls

### 4.2 Common logic tests
- [ ] Auth: `_authLogin`, `_authVerifySession`, `_authChangePassword`
- [ ] Data: `_toRow`, `_fromRow` for all table types
- [ ] Utils: `uid()`, `byId()`, `hasRole()`, date formatting, parsing

### 4.3 HRMS business logic tests
- [ ] PL calculation: `_hrmsCalcPLGiven`, `_hrmsCumPLAvail`, `_hrmsGetConfirmationDate`
- [ ] Months since confirmation: `_hrmsMonthsSinceConfirmation` (rounding, edge cases)
- [ ] Salary calculation: OT rules, IOT deduction, attendance bonus, PF/ESI/PT
- [ ] Day type lookup: `_hrmsGetDayType` per plant
- [ ] Period matching: correct salary rate for month

### 4.4 VMS business logic tests
- [ ] `canDoStep`: role-based step access (Admin, Plant Head, KAP Security, etc.)
- [ ] `stepsOneAndTwoDone`, `stepsOneTwoThreeDone`
- [ ] Badge count calculations
- [ ] OT calculations (working day, Sunday)

### 4.5 HWMS business logic tests
- [ ] Invoice calculations
- [ ] Container tracking logic
- [ ] Material request workflows

---

## Phase 5: Code Optimization

### 5.1 Dead code removal
- [ ] Find and remove unused functions across all files
- [ ] Remove commented-out code blocks
- [ ] Remove unused CSS classes

### 5.2 Consolidate duplicates
- [ ] Identify duplicate logic across apps (date formatting, table rendering, filter patterns)
- [ ] Move shared utilities to `js/common.js`
- [ ] Consolidate duplicate table/grid rendering patterns

### 5.3 Performance
- [ ] Reduce unnecessary DOM rebuilds (use incremental updates where possible)
- [ ] Optimize large list rendering (virtual scrolling for 1000+ rows)
- [ ] Lazy-load heavy components (PDF export libraries, XLSX parser)

---

## Phase 6: Code Beautification

### 6.1 Naming conventions
- [ ] Functions: `camelCase` with verb prefix (`renderUsers`, `calcSalary`, `fetchAttendance`)
- [ ] Constants: `UPPER_SNAKE_CASE` (`MAX_RETRIES`, `FULL_DAY_HOURS`)
- [ ] Private/internal: `_` prefix (`_initApp`, `_syncData`)
- [ ] DOM IDs: `kebab-case` or consistent `camelCase`

### 6.2 Documentation
- [ ] Add file-level JSDoc headers (purpose, dependencies, exports)
- [ ] Add JSDoc to all public functions (params, returns, description)
- [ ] Add section separator comments (`// ═══ SECTION NAME ═══`)
- [ ] Document complex business rules inline

### 6.3 Formatting
- [ ] Consistent 2-space indentation
- [ ] Line length max ~120 chars
- [ ] Consistent brace style
- [ ] Group related functions together

---

## Phase 7: Documentation (HTML)

### 7.1 Product Requirements Document
- [ ] App overview and purpose (Portal, VMS, HRMS, HWMS, Security)
- [ ] Feature list per app
- [ ] User roles and permissions matrix
- [ ] Data model and relationships
- [ ] Integration points (Supabase, realtime sync)

### 7.2 User Stories
- [ ] Portal: login, password management, app navigation
- [ ] VMS: trip booking, gate entry/exit, material receipt, approval, spot trips
- [ ] HRMS: employee management, attendance, salary, settings
- [ ] HWMS: containers, invoices, material requests, parts, payments
- [ ] Security: guard management, checkpoints, round schedules

### 7.3 Architecture Document
- [ ] System overview (static site + Supabase backend)
- [ ] File structure and module dependencies
- [ ] Data flow diagrams (login, sync, save)
- [ ] Database schema (all tables, columns, relationships)
- [ ] Authentication flow (bcrypt, session tokens)
- [ ] Sync architecture (boot, hot sync, full sync, incremental)

### 7.4 Training Documents (per user role)
- [ ] Super Admin / Admin: user management, system settings, all features
- [ ] Plant Head: dashboard, approvals, overrides
- [ ] Trip Booking User: create trips, track status
- [ ] KAP Security: gate operations, entry/exit
- [ ] Material Receiver: receive materials, update steps
- [ ] Trip Approver: review and approve/reject trips
- [ ] HRMS Users: attendance, salary, employee data
- [ ] HWMS Users: containers, invoices, material requests
- [ ] Vendor Users: view assigned trips

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
