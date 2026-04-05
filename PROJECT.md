# PROJECT.md — Project-Specific Context
# ========================================
# PURPOSE OF THIS FILE:
# This file contains everything that is specific to THIS project.
# It is read by Claude Code at the start of every session to establish context.
# Claude has no memory between sessions — this file IS the memory.
#
# CLAUDE.md contains the universal engineering rules (never edit those for a project).
# This file contains the who/what/where/how for this specific project.
#
# KEEP THIS FILE UPDATED:
# When the stack changes, update Section 2.
# When commands change, update Section 3.
# When a new quirk is discovered, add it to Section 6.
# Treat this file with the same care as the codebase itself.
# ========================================


---


# SECTION P1 — Project identity
# ================================

Project name:    KAP myApps Portal
Owner / company: Kelkar Auto Parts Private Limited
Description:     Internal web application portal for KAP staff. Provides three
                 operational modules — Vehicle Management (VMS), Hardware/Warehouse
                 Management (HWMS), and Security Surveillance — all accessible via
                 a single login portal (index.html). Data is stored and synced via
                 Supabase (hosted PostgreSQL).

Primary users:   Factory/warehouse staff, transport coordinators, security guards,
                 and management at Kelkar Auto Parts.

Project started: Approximately early 2025
Current status:  Active development


---


# SECTION P2 — Technology stack
# ================================

Language:        Vanilla JavaScript (ES6+), HTML5, CSS3
Framework:       None — pure HTML/CSS/JS, no build framework
Frontend:        Plain HTML + CSS + JavaScript (single-file apps, self-contained)
Database:        Supabase (hosted PostgreSQL accessed via Supabase JS client over HTTPS)
ORM / DB layer:  Supabase JS client (supabase-js v2, loaded via CDN)
Hosting:         Static files — opened directly in a browser, or served from any
                 static file host. No server-side runtime required.
OS (server):     N/A (pure client-side)

Other key libraries or services:
  - Supabase (database, auth, realtime — https://supabase.com)
  - Supabase JS client loaded from CDN in each HTML file
  - No npm, no bundler, no build step required


---


# SECTION P3 — Key commands
# ===========================

Install dependencies: None — no dependencies to install. Open HTML files directly.
Start (development):  Open index.html in a browser (double-click or use Live Server
                      extension in VS Code for auto-reload)
Start (production):   Deploy HTML/JS files to any static host (e.g. GitHub Pages,
                      Netlify, or serve via IIS/nginx from a local server)
Run tests:            No automated test suite exists yet. Manual testing in browser.
Run a single test:    N/A
Lint / format code:   No linter configured. Consider adding ESLint if needed.
Database migrations:  Managed via Supabase Dashboard (supabase.com/dashboard)
Backup database:      Via Supabase Dashboard → Settings → Database → Backups
Deploy:               Push to GitHub → GitHub Pages auto-deploys, OR copy files to
                      the internal server


---


# SECTION P4 — Repository and issue tracking
# ============================================

GitHub repo URL:  https://github.com/Kelkar-Auto-Parts-Private-Limited/myApps
                  (also mirrored at https://github.com/mayuresh/KAP-Projects)
Main branch:      main
Issue tracker:    GitHub Issues are DISABLED on this repository.
                  Track issues manually in PROJECT.md Section P9, or enable Issues
                  in the repo settings when ready.

Branch naming convention:
  feature/<short-description>   (no issue number — issues disabled)
  fix/<short-description>
  docs/<short-description>
  refactor/<short-description>


---


# SECTION P5 — Environment variables and secrets
# ================================================
# The Supabase anon key in Common.js is intentionally public-facing.
# Supabase anon keys are designed to be embedded in client-side code — they are
# not secrets. Security is enforced by Row Level Security (RLS) policies on
# the database side, not by hiding the key.
#
# HOWEVER: if a Supabase service_role key is ever added, it MUST be treated as
# a secret and never committed to the repository.

Currently no .env file is needed — all config is in Common.js:
  SUPABASE_URL  = https://ehzfknwkerafblnibhps.supabase.co  (public, safe to commit)
  SUPABASE_KEY  = anon/public key (public, safe to commit — see note above)

If secrets are added in future:
  1. Create a .env file (never commit it)
  2. Add .env to .gitignore
  3. Add variable names to .env.example


---


# SECTION P6 — Documentation
# ============================
# All project documentation lives in the /docs folder as HTML files.
# These docs are MAINTAINED and up to date — they are the authoritative source.
# For architecture questions, READ docs/architecture.html rather than re-deriving
# from the code. For requirements questions, READ docs/requirements.html.

| File                      | Status   | Last updated        |
|---------------------------|----------|---------------------|
| docs/index.html           | EXISTS   | 2026-04-03 16:57    |
| docs/requirements.html    | EXISTS   | 2026-04-03 16:57    |
| docs/architecture.html    | EXISTS   | 2026-04-05 18:04    |
| docs/changelog.html       | EXISTS   | 2026-04-03 16:57    |
| docs/runbook.html         | EXISTS   | 2026-04-03 16:57    |

To open documentation locally: open docs/index.html in any browser.

IMPORTANT: Per CLAUDE.md Section 5.0, any code commit that changes the file
structure, system capabilities, or deployment process must include an update to
the relevant doc(s) in the same commit. When updating a doc:
  1. Update its "Last updated" timestamp in the doc's <p class="meta"> line.
  2. Update its timestamp in this table (format: YYYY-MM-DD HH:MM, 24-hour local time).
Documentation may change multiple times a day — always record the time, not just the date.


---


# SECTION P7 — Architecture overview
# =====================================

Single-page static apps — no server runtime. All logic runs in the browser.

  Browser → HTML file (loads Supabase JS from CDN)
          → Common.js (shared data layer, Supabase client, utilities)
          → Supabase REST API → hosted PostgreSQL database

File structure (HTML files contain structure only — JS was extracted in refactor #1):
  index.html          Portal login page + app launcher (logic in js/Portal.js)
  VMS.html            Vehicle Management System (logic in js/VMS.js)
  HWMS.html           Hardware/Warehouse Management System (logic in js/HWMS.js)
  Security.html       Security Surveillance (logic in js/Security.js)
  js/Common.js        Shared foundation: Supabase config, DB helpers, spinner,
                        user session, Excel/export utilities. Loaded by all modules.
  js/Portal.js        Login flow, session management, user management UI
  js/VMS.js           VMS application logic
  js/HWMS.js          HWMS application logic
  js/Security.js      Security application logic
  css/Shared.css      Shared stylesheet for all modules

Full architecture detail: see docs/architecture.html

Supabase tables (prefixed by module):
  vms_*     Vehicle Management tables
  hwms_*    Hardware/Warehouse Management tables
  ss_*      Security Surveillance tables

Authentication:
  Custom user table (vms_users) — login handled in JS with username/password
  Math CAPTCHA on login form (client-side)
  "Remember me" persists session in localStorage


---


# SECTION P8 — Known constraints and quirks
# ===========================================

- NO BUILD STEP: There is no npm, webpack, or bundler. Files are edited and
  deployed directly. Changes are live immediately after saving and refreshing.

- NO TEST SUITE: There are currently no automated tests. All testing is manual
  in the browser. This is a known gap — adding tests would require a framework
  like Jest or Playwright to be introduced.

- NO .GITIGNORE: The repository does not have a .gitignore file yet. One should
  be added to exclude OS files (.DS_Store, Thumbs.db) and any future .env files.

- GITHUB ISSUES DISABLED: The repo has GitHub Issues turned off. Track work items
  in Section P9 of this file until Issues are enabled.

- SUPABASE ANON KEY IS PUBLIC BY DESIGN: The key in Common.js is the
  Supabase anon/public key. This is correct — it is not a secret. Security is
  enforced by Supabase Row Level Security (RLS) rules on the database.
  Never add the service_role key to any client-side file.

- LARGE JS FILES: js/HWMS.js (~815 KB) and js/VMS.js (~510 KB) are very large.
  Editing them requires care — always read the relevant section before making changes.

- DOCS ARE MAINTAINED: The /docs folder exists and all HTML documentation files
  are kept up to date. Read them rather than re-deriving from code.


---


# SECTION P9 — Recent context
# =============================

Last session date:   2026-04-05

Work log (GitHub Issues disabled — tracked here per CLAUDE.md Section 3.3):

  [2026-04-05 15:30] Sync architecture doc and enforce doc-before-commit rule
    — docs/architecture.html was outdated after the JS extraction refactor.
      Updated to show js/ and css/ folders with correct file sizes. Added
      CLAUDE.md Section 5.0 requiring docs to be updated before committing when
      file structure or capabilities change. Updated PROJECT.md P6/P7/P8/P9.
      Committed as 707a878.

  [2026-04-05 18:04] Add fallback work-tracking rule for when Issues are disabled
    — CLAUDE.md had a hard rule to always create a GitHub Issue but no fallback
      for when Issues are disabled. Added Section 3.3 requiring a PROJECT.md P9
      log entry instead. Updated Section 9.5. CLAUDE.md bumped to v4.2.

Issues closed:       None (Issues disabled on repo)
Current open issues: None tracked
Suggested next step: 1. Add a .gitignore file
                     2. Commit pending changes (CLAUDE.md, PROJECT.md)


---


# END OF PROJECT.md
# ==================
# This file is the memory between Claude Code sessions.
# Keep it accurate and up to date — an outdated PROJECT.md
# is worse than no PROJECT.md because it causes Claude to
# make decisions based on wrong assumptions.
#
# Last reviewed: 2026-04-05
