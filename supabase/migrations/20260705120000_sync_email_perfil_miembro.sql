-- ============================================================================
-- Sync auth.users.email → usuarios.email al confirmar el cambio de correo
-- ----------------------------------------------------------------------------
-- El miembro puede editar su correo desde su perfil (self-serve). El correo de
-- login vive en auth.users y solo cambia cuando el miembro CONFIRMA el cambio
-- (Supabase envía un enlace). En ese momento auth.users.email se actualiza y
-- este trigger propaga el nuevo correo a usuarios.email para que la app, Stripe
-- y recepción queden consistentes.
--
-- Espejo del patrón de on_auth_user_created (20260514101000). SECURITY DEFINER
-- porque el UPDATE lo dispara auth (supabase_auth_admin), no el miembro.
-- ============================================================================

CREATE OR REPLACE FUNCTION handle_auth_user_email_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE usuarios SET email = NEW.email WHERE auth_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  WHEN (NEW.email IS DISTINCT FROM OLD.email)
  EXECUTE FUNCTION handle_auth_user_email_change();
