-- ============================================================================
-- MyApps Authentication Security Migration
-- Run this ENTIRE script in Supabase SQL Editor BEFORE deploying updated code
-- ============================================================================

-- Step 1: Enable pgcrypto extension for bcrypt hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Step 2: Add session_token column to vms_users
ALTER TABLE vms_users ADD COLUMN IF NOT EXISTS session_token TEXT DEFAULT '';

-- Step 3: Create verify_login function
-- Returns user row if username + password match (bcrypt), else empty
CREATE OR REPLACE FUNCTION verify_login(p_username TEXT, p_password TEXT)
RETURNS TABLE(
  id BIGINT, code TEXT, name TEXT, full_name TEXT, mobile TEXT, email TEXT,
  roles JSONB, hwms_roles JSONB, hrms_roles JSONB, plant TEXT, apps JSONB,
  photo TEXT, inactive BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.code, u.name, u.full_name, u.mobile, u.email,
         u.roles, u.hwms_roles, u.hrms_roles, u.plant, u.apps,
         u.photo, u.inactive
  FROM vms_users u
  WHERE LOWER(u.name) = LOWER(p_username)
    AND u.password = crypt(p_password, u.password);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 4: Create session function
-- Verifies credentials, generates random token, stores it, returns token
CREATE OR REPLACE FUNCTION create_session(p_username TEXT, p_password TEXT)
RETURNS TEXT AS $$
DECLARE
  v_token TEXT;
  v_code TEXT;
BEGIN
  SELECT u.code INTO v_code
  FROM vms_users u
  WHERE LOWER(u.name) = LOWER(p_username)
    AND u.password = crypt(p_password, u.password);

  IF v_code IS NULL THEN RETURN NULL; END IF;

  v_token := encode(gen_random_bytes(32), 'hex');

  UPDATE vms_users SET session_token = v_token WHERE code = v_code;

  RETURN v_token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 5: Create verify_session function
-- Returns user row if username + token match, else empty
CREATE OR REPLACE FUNCTION verify_session(p_username TEXT, p_token TEXT)
RETURNS TABLE(
  id BIGINT, code TEXT, name TEXT, full_name TEXT, mobile TEXT, email TEXT,
  roles JSONB, hwms_roles JSONB, hrms_roles JSONB, plant TEXT, apps JSONB,
  photo TEXT, inactive BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.code, u.name, u.full_name, u.mobile, u.email,
         u.roles, u.hwms_roles, u.hrms_roles, u.plant, u.apps,
         u.photo, u.inactive
  FROM vms_users u
  WHERE LOWER(u.name) = LOWER(p_username)
    AND u.session_token = p_token
    AND p_token IS NOT NULL AND p_token != '';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 6: Create change_password function
-- Verifies old password server-side, hashes and stores new password
CREATE OR REPLACE FUNCTION change_password(p_username TEXT, p_old_password TEXT, p_new_password TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT u.code INTO v_code
  FROM vms_users u
  WHERE LOWER(u.name) = LOWER(p_username)
    AND u.password = crypt(p_old_password, u.password);

  IF v_code IS NULL THEN RETURN FALSE; END IF;

  UPDATE vms_users
  SET password = crypt(p_new_password, gen_salt('bf', 10))
  WHERE code = v_code;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 7: Create admin_reset_password function
-- Only works if caller is Admin/Super Admin, resets target to hashed default
CREATE OR REPLACE FUNCTION admin_reset_password(p_admin_code TEXT, p_target_code TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM vms_users
    WHERE code = p_admin_code
      AND (roles ? 'Super Admin' OR roles ? 'Admin')
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN RETURN FALSE; END IF;

  UPDATE vms_users
  SET password = crypt('Kappl@123', gen_salt('bf', 10)),
      session_token = ''
  WHERE code = p_target_code;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 8: Create hash_password function (for admin user creation)
CREATE OR REPLACE FUNCTION hash_password(p_plain TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN crypt(p_plain, gen_salt('bf', 10));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 9: Create set_hashed_password function (for saving new users / updating password from admin)
CREATE OR REPLACE FUNCTION set_hashed_password(p_user_code TEXT, p_plain_password TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE vms_users
  SET password = crypt(p_plain_password, gen_salt('bf', 10))
  WHERE code = p_user_code;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Step 10: ONE-TIME MIGRATION — Hash all existing plaintext passwords
-- This is IDEMPOTENT — already-hashed passwords (starting with $2a$ or $2b$) are skipped
-- ============================================================================
UPDATE vms_users
SET password = crypt(password, gen_salt('bf', 10))
WHERE password NOT LIKE '$2a$%' AND password NOT LIKE '$2b$%';

-- ============================================================================
-- DONE! Now deploy the updated HTML/JS files.
-- All users will need to re-login (old sessions invalidated).
-- ============================================================================
