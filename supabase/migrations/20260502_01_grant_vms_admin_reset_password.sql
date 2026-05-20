-- ─────────────────────────────────────────────────────────────────────────
-- Extend admin_reset_password to allow VMS Admin in addition to Super
-- Admin / Admin. The portal user list already exposes the Reset (🔑)
-- button to VMS Admin via canManageUsers, but the SQL gate was rejecting
-- their call → silent "Failed to reset password" for VMS Admin users.
--
-- Same SECURITY DEFINER body — only the role check changes. CREATE OR
-- REPLACE swaps in the new body without dropping the function or
-- breaking dependent grants. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_reset_password(p_admin_code TEXT, p_target_code TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM vms_users
    WHERE code = p_admin_code
      AND (roles ? 'Super Admin' OR roles ? 'Admin' OR roles ? 'VMS Admin')
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN RETURN FALSE; END IF;

  UPDATE vms_users
  SET password = crypt('Kappl@123', gen_salt('bf', 10)),
      session_token = ''
  WHERE code = p_target_code;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
