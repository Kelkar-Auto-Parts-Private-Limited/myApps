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
# The Supabase anon key in myApps_Common.js is intentionally public-facing.
# Supabase anon keys are designed to be embedded in client-side code — they are
# not secrets. Security is enforced by Row Level Security (RLS) policies on
# the database side, not by hiding the key.
#
# HOWEVER: if a Supabase service_role key is ever added, it MUST be treated as
# a secret and never committed to the repository.

Currently no .env file is needed — all config is in myApps_Common.js:
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

| File                      | Status  | Last updated  |
|---------------------------|---------|---------------|
| docs/index.html           | NEEDED  | n/a           |
| docs/requirements.html    | NEEDED  | n/a           |
| docs/architecture.html    | NEEDED  | n/a           |
| docs/changelog.html       | NEEDED  | n/a           |
| docs/runbook.html         | NEEDED  | n/a           |

To open documentation locally: open docs/index.html in any browser.


---


# SECTION P7 — Architecture overview
# =====================================

Single-page static apps — no server runtime. All logic runs in the browser.

  Browser → HTML file (loads Supabase JS from CDN)
          → myApps_Common.js (shared data layer, Supabase client, utilities)
          → Supabase REST API → hosted PostgreSQL database

File structure:
  index.html          Portal login + app launcher (navigates to individual apps)
  myApps_Common.js    Shared foundation: Supabase config, DB helpers, spinner,
                      user session, Excel/export utilities. Loaded by all modules.
  myApps_VMS.html     Vehicle Management System — trips, drivers, vehicles, vendors,
                      locations, trip rates, segments, spot trips
  myApps_HWMS.html    Hardware/Warehouse Management System — parts, invoices,
                      containers, HSN codes, UOM, packing, customers, ports,
                      carriers, companies, steel rates, sub-invoices, material
                      requests, payment receipts
  myApps_Security.html  Security Surveillance — checkpoints, guards, round schedules

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

- SUPABASE ANON KEY IS PUBLIC BY DESIGN: The key in myApps_Common.js is the
  Supabase anon/public key. This is correct — it is not a secret. Security is
  enforced by Supabase Row Level Security (RLS) rules on the database.
  Never add the service_role key to any client-side file.

- LARGE FILES: myApps_HWMS.html (~1 MB) and myApps_VMS.html (~700 KB) are very
  large single-file apps. Editing them requires care — always read the relevant
  section before making changes.

- DOCS FOLDER MISSING: The /docs folder and all HTML documentation files do not
  exist yet. They should be created before this project grows further.


---


# SECTION P9 — Recent context
# =============================

Last session date:   2026-04-03
Last session work:   Initial project setup — cloned repo, read CLAUDE.md,
                     filled in PROJECT.md from codebase inspection.
Issues closed:       None (Issues disabled on repo)
Current open issues: None tracked
Suggested next step: 1. Add a .gitignore file
                     2. Create the /docs folder with docs/index.html,
                        docs/requirements.html, docs/architecture.html,
                        docs/changelog.html, docs/runbook.html
                     3. Commit CLAUDE.md, PROJECT.md, and .gitignore to the repo


---


# END OF PROJECT.md
# ==================
# This file is the memory between Claude Code sessions.
# Keep it accurate and up to date — an outdated PROJECT.md
# is worse than no PROJECT.md because it causes Claude to
# make decisions based on wrong assumptions.
#
# Last reviewed: 2026-04-03
