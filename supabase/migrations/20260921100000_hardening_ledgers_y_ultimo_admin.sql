-- ============================================================================
-- Endurecimiento: último admin · ledgers inmutables · columnas privilegiadas ·
-- oráculo de membresía sin GRANT de más (SALA_PARITY_AUDIT_2 §3.2 S2–S5)
-- ============================================================================

-- ── S2 + S4. Trigger de `usuarios` ───────────────────────────────────────────
-- Recrea `proteger_columnas_privilegiadas_usuarios` (20260620170000) con dos cosas más:
--  · S4: `email`, `auth_id`, `membresia_activa_id`, `notas_admin` e `invitado`
--    tampoco los toca un miembro sobre su propia fila. `notas_admin` es lo que
--    recepción lee en el check-in; `membresia_activa_id` reapunta la membresía;
--    el email es el login y se cambia solo por recepción (audit) o por Auth.
--    (El miembro edita nombre y teléfono desde su perfil: eso sigue igual.)
--  · S2: backstop "último admin": nadie —ni service_role, ni el SQL editor— deja
--    un estudio sin ningún admin activo. Antes solo lo comprobaba el front de
--    Equipo; dos admins degradándose a la vez, o un UPDATE directo, dejaban el
--    tenant sin quien pudiera entrar al panel. (SALA 20260613002500 C3.)
CREATE OR REPLACE FUNCTION proteger_columnas_privilegiadas_usuarios()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND NOT is_admin() THEN
    IF NEW.rol                 IS DISTINCT FROM OLD.rol
    OR NEW.tenant_id           IS DISTINCT FROM OLD.tenant_id
    OR NEW.status              IS DISTINCT FROM OLD.status
    OR NEW.membresia_tier      IS DISTINCT FROM OLD.membresia_tier
    OR NEW.membresia_activa_id IS DISTINCT FROM OLD.membresia_activa_id
    OR NEW.no_shows_count      IS DISTINCT FROM OLD.no_shows_count
    OR NEW.bloqueado_hasta     IS DISTINCT FROM OLD.bloqueado_hasta
    OR NEW.identidad_completa  IS DISTINCT FROM OLD.identidad_completa
    OR NEW.contrato_firmado    IS DISTINCT FROM OLD.contrato_firmado
    OR NEW.email               IS DISTINCT FROM OLD.email
    OR NEW.auth_id             IS DISTINCT FROM OLD.auth_id
    OR NEW.notas_admin         IS DISTINCT FROM OLD.notas_admin
    OR NEW.invitado            IS DISTINCT FROM OLD.invitado THEN
      RAISE EXCEPTION
        'EKKO_NO_AUTORIZADO: No puedes modificar campos privilegiados de tu cuenta';
    END IF;
  END IF;

  -- Último admin: aplica a TODOS los actores. En un BEFORE trigger la fila aún es
  -- OLD, así que el conteo incluye a este mismo admin.
  IF OLD.rol = 'admin' AND OLD.status = 'activo'
     AND (NEW.rol IS DISTINCT FROM 'admin' OR NEW.status IS DISTINCT FROM 'activo')
     AND count_admins_activos(OLD.tenant_id) <= 1 THEN
    RAISE EXCEPTION
      'EKKO_ULTIMO_ADMIN: No puedes dejar el estudio sin ningún admin activo. Nombra otro admin primero.';
  END IF;

  RETURN NEW;
END;
$$;

-- Y contra el DELETE del último admin (admin-delete-user ya lo bloquea; esto es
-- por si alguien lo hace desde el SQL editor).
CREATE OR REPLACE FUNCTION usuarios_no_borrar_ultimo_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.rol = 'admin' AND OLD.status = 'activo' AND count_admins_activos(OLD.tenant_id) <= 1 THEN
    RAISE EXCEPTION
      'EKKO_ULTIMO_ADMIN: No puedes borrar al único admin activo del estudio. Nombra otro admin primero.';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION usuarios_no_borrar_ultimo_admin() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_no_borrar_ultimo_admin ON usuarios;
CREATE TRIGGER trg_no_borrar_ultimo_admin
  BEFORE DELETE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION usuarios_no_borrar_ultimo_admin();

-- ── S5. Ledgers append-only ──────────────────────────────────────────────────
-- `membresia_movimientos` y `audit_log` solo estaban protegidos por RLS: con
-- service_role o desde el SQL editor se podía reescribir el historial de créditos
-- o la bitácora sin dejar rastro. Ahora un trigger lo impide para cualquiera.
--  · audit_log: ni UPDATE ni DELETE, nunca.
--  · membresia_movimientos: ni UPDATE (salvo el SET NULL de `reserva_id` que
--    dispara la FK al borrar una reserva) ni DELETE, salvo el que arrastra el
--    CASCADE al borrar la membresía/el miembro (en ese momento la membresía ya
--    no existe).
CREATE OR REPLACE FUNCTION ledger_inmutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'audit_log' THEN
    RAISE EXCEPTION 'EKKO_LEDGER_INMUTABLE: La bitácora no se modifica ni se borra';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.reserva_id IS NULL AND OLD.reserva_id IS NOT NULL
       AND NEW.id = OLD.id AND NEW.tenant_id = OLD.tenant_id AND NEW.membresia_id = OLD.membresia_id
       AND NEW.usuario_id = OLD.usuario_id AND NEW.tipo = OLD.tipo AND NEW.delta = OLD.delta
       AND NEW.saldo_after IS NOT DISTINCT FROM OLD.saldo_after AND NEW.motivo IS NOT DISTINCT FROM OLD.motivo
       AND NEW.created_at = OLD.created_at THEN
      RETURN NEW; -- ON DELETE SET NULL de reservas
    END IF;
    RAISE EXCEPTION 'EKKO_LEDGER_INMUTABLE: Un movimiento de créditos no se modifica; registra un ajuste';
  END IF;

  -- DELETE: solo el CASCADE (la membresía padre ya no existe).
  IF EXISTS (SELECT 1 FROM membresias WHERE id = OLD.membresia_id) THEN
    RAISE EXCEPTION 'EKKO_LEDGER_INMUTABLE: Un movimiento de créditos no se borra';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION ledger_inmutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ledger_inmutable ON membresia_movimientos;
CREATE TRIGGER trg_ledger_inmutable
  BEFORE UPDATE OR DELETE ON membresia_movimientos
  FOR EACH ROW EXECUTE FUNCTION ledger_inmutable();

DROP TRIGGER IF EXISTS trg_audit_inmutable ON audit_log;
CREATE TRIGGER trg_audit_inmutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ledger_inmutable();

-- ── S3. `_estado_membresia_checkin` sin GRANT a authenticated ────────────────
-- Era DEFINER, concedida a `authenticated` y sin guard de tenant ni de rol:
-- cualquier miembro podía consultar por UUID si OTRA persona estaba vencida,
-- suspendida o con pago pendiente. Las RPC de check-in que la usan son DEFINER y
-- no necesitan el GRANT; el front nunca la llama (grep = 0).
REVOKE ALL ON FUNCTION _estado_membresia_checkin(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _estado_membresia_checkin(uuid, uuid) TO service_role;
