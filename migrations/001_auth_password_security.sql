-- ============================================================
-- Migration 001: Auth Password Security
-- Branch:  fix/auth-password-security
-- Date:    2026-04-05
-- Purpose: Fix auth Problems 1-3:
--   Problem 1 — passwords downloaded to every browser on page load
--   Problem 2 — passwords stored in plain text in the database
--   Problem 3 — passwords stored in plain text in localStorage
--
-- What this migration does:
--   1. Enables pgcrypto for bcrypt hashing
--   2. Adds session_token, session_expires_at, force_password_change columns
--   3. Marks users with the default password as needing a forced change
--   4. Hashes all existing passwords with bcrypt (one-way, irreversible)
--   5. Creates 4 RPC functions callable by the browser via the anon key:
--      - verify_login:   checks credentials, returns user profile + session token
--      - verify_session: validates a session token, returns user profile
--      - set_password:   user changes own password (requires old password,
--                        or skips check when force_password_change = true)
--      - reset_password: admin resets a user's password, forces change on next login
--
-- Deploy order:
--   1. Run this entire file in Supabase Dashboard → SQL Editor → New query
--   2. Confirm no errors — especially Step 4 (the hash migration)
--   3. Deploy/reload the code from the fix/auth-password-security branch
--   4. Test login with a known user
--   5. Merge branch to main once confirmed working
--
-- WARNING: Step 4 is irreversible. Take a DB backup before running if needed.
--          Supabase Dashboard → Settings → Database → Backups
-- ============================================================


-- ── Step 1: Enable pgcrypto ──────────────────────────────────────────────────
-- Provides crypt() and gen_salt() for bcrypt hashing.
-- Safe to run even if already enabled.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ── Step 2: Add new columns to vms_users ────────────────────────────────────
ALTER TABLE vms_users ADD COLUMN IF NOT EXISTS session_token        TEXT;
ALTER TABLE vms_users ADD COLUMN IF NOT EXISTS session_expires_at   TIMESTAMPTZ;
ALTER TABLE vms_users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT false;


-- ── Step 3: Mark users with default password as needing a forced change ──────
-- Must run BEFORE Step 4 — we can still read the plain text value here.
UPDATE vms_users
SET force_password_change = true
WHERE password = 'Kappl@123';


-- ── Step 4: Hash all existing passwords with bcrypt ─────────────────────────
-- WARNING: This is one-way. Passwords cannot be recovered after this step.
-- After this runs, only the RPC functions (below) can verify credentials.
UPDATE vms_users
SET password = crypt(password, gen_salt('bf'));


-- ── Step 5: RPC — verify_login ───────────────────────────────────────────────
-- Called by the browser at login time.
-- Checks the bcrypt hash server-side, issues a 30-day session token.
-- Returns the user profile + session token. Never returns the password.
CREATE OR REPLACE FUNCTION verify_login(p_username TEXT, p_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user        vms_users%ROWTYPE;
  v_token       TEXT;
  v_expires     TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_user
  FROM vms_users
  WHERE LOWER(name) = LOWER(p_username)
    AND inactive = false;

  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_user.password != crypt(p_password, v_user.password) THEN RETURN NULL; END IF;

  v_token   := gen_random_uuid()::TEXT;
  v_expires := NOW() + INTERVAL '30 days';

  UPDATE vms_users
  SET session_token = v_token, session_expires_at = v_expires
  WHERE id = v_user.id;

  RETURN jsonb_build_object(
    'id',                   v_user.id,
    'code',                 v_user.code,
    'name',                 v_user.name,
    'full_name',            v_user.full_name,
    'mobile',               v_user.mobile,
    'email',                v_user.email,
    'roles',                v_user.roles,
    'hwms_roles',           v_user.hwms_roles,
    'plant',                v_user.plant,
    'apps',                 v_user.apps,
    'photo',                v_user.photo,
    'inactive',             v_user.inactive,
    'force_password_change',v_user.force_password_change,
    'session_token',        v_token
  );
END;
$$;


-- ── Step 6: RPC — verify_session ────────────────────────────────────────────
-- Called by the browser on page load to restore a session.
-- Validates the stored token against the DB. Returns user profile if valid.
-- Returns NULL if the token is missing, expired, or the user is inactive.
CREATE OR REPLACE FUNCTION verify_session(p_username TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user vms_users%ROWTYPE;
BEGIN
  SELECT * INTO v_user
  FROM vms_users
  WHERE LOWER(name)         = LOWER(p_username)
    AND session_token       = p_token
    AND session_expires_at  > NOW()
    AND inactive            = false;

  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'id',                   v_user.id,
    'code',                 v_user.code,
    'name',                 v_user.name,
    'full_name',            v_user.full_name,
    'mobile',               v_user.mobile,
    'email',                v_user.email,
    'roles',                v_user.roles,
    'hwms_roles',           v_user.hwms_roles,
    'plant',                v_user.plant,
    'apps',                 v_user.apps,
    'photo',                v_user.photo,
    'inactive',             v_user.inactive,
    'force_password_change',v_user.force_password_change
  );
END;
$$;


-- ── Step 7: RPC — set_password ───────────────────────────────────────────────
-- Called when a user changes their own password.
-- Verifies the old password before accepting the new one.
-- Exception: if force_password_change = true, the old password check is skipped
-- (covers first-login forced change and admin-reset scenarios).
-- Sets force_password_change = false on success.
CREATE OR REPLACE FUNCTION set_password(
  p_user_code     TEXT,
  p_old_password  TEXT,
  p_new_password  TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user vms_users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM vms_users WHERE code = p_user_code;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Skip old-password check for forced changes (first login / admin reset)
  IF NOT v_user.force_password_change THEN
    IF v_user.password != crypt(p_old_password, v_user.password) THEN
      RETURN FALSE;
    END IF;
  END IF;

  UPDATE vms_users
  SET password             = crypt(p_new_password, gen_salt('bf')),
      force_password_change = false
  WHERE code = p_user_code;

  RETURN TRUE;
END;
$$;


-- ── Step 8: RPC — reset_password ────────────────────────────────────────────
-- Called by an admin to reset another user's password.
-- Sets force_password_change = true so the user must change on next login.
-- Clears session_token so any active session is immediately invalidated.
CREATE OR REPLACE FUNCTION reset_password(p_user_code TEXT, p_new_password TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE vms_users
  SET password              = crypt(p_new_password, gen_salt('bf')),
      force_password_change  = true,
      session_token          = NULL,
      session_expires_at     = NULL
  WHERE code = p_user_code;

  RETURN FOUND;
END;
$$;
