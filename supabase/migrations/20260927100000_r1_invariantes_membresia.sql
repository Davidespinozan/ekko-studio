-- ============================================================================
-- F2 · R1 — Invariantes de membresía y observabilidad (2026-09-27)
-- ============================================================================
-- Fase quirúrgica. NO introduce el modelo de derecho canónico (R2) ni toca el
-- contrato externo de activar_membresia. Cierra:
--   1. P0-1: el check-in por QR admitía a un sancionado o revocado si su reserva
--      ya se había pagado con créditos (el atajo del débito iba ANTES de mirar la
--      cuenta). La cuenta se evalúa primero; el débito sigue valiendo como pago.
--   2. Check-in manual: una cuenta REVOCADA no entra ni por mostrador (la
--      revocación retira el acceso; se recupera solo con restaurar_acceso_revocado).
--      Una cuenta SANCIONADA puede entrar por excepción de recepción, con aviso y
--      auditada como override, nunca como un ingreso normal.
--   3. Revocación persistente: ningún ciclo de membresía (activar, sync de
--      Stripe, pausa, reanudación, baja, edición) la levanta. Solo la operación
--      explícita `restaurar_acceso_revocado` (admin, con motivo, auditada).
--   4. sync_membresia_stripe: una membresía `cancelada` o `expirada` localmente
--      no resucita por un evento de Stripe; se registra la contradicción y se
--      responde con éxito (sin reintentos infinitos). El orden de eventos ya no
--      descarta un evento DISTINTO del mismo segundo.
--   5. Auditoría del ciclo de vida con el estado REAL persistido (triggers AFTER).
--   6. Vista de reconciliación de solo lectura (v_reconciliacion_membresia).
-- Tests: src/__tests__/db/r1-invariantes.db.test.ts
-- ============================================================================

-- ── 1. P0-1 · Check-in: la cuenta antes que el atajo del débito ─────────────
-- Cuerpo de 20260821190000:22-58 (grants de 20260921100000). Cambia el orden:
--   revocado → 'cuenta_revocado'; sanción vigente → 'cuenta_sancionada';
--   luego el débito (la sesión ya pagada no exige membresía vigente ni vuelve a
--   debitar); luego el resto igual que antes.
-- La pausa (status 'suspendido' sin sanción) conserva su comportamiento: una
-- reserva ya pagada con créditos sigue entrando.
CREATE OR REPLACE FUNCTION _estado_membresia_checkin(p_usuario_id uuid, p_reserva_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_sancionado_at timestamptz;
  v_mem record;
BEGIN
  SELECT status, sancionado_at INTO v_status, v_sancionado_at
  FROM usuarios WHERE id = p_usuario_id;

  -- Restricciones de CUENTA: mandan sobre cualquier pago previo.
  IF v_status = 'revocado' THEN
    RETURN 'cuenta_revocado';
  END IF;
  IF v_sancionado_at IS NOT NULL THEN
    RETURN 'cuenta_sancionada';
  END IF;

  -- La sesión ya se pagó con créditos → pasa aunque el paquete haya caducado después.
  IF EXISTS (SELECT 1 FROM membresia_movimientos WHERE reserva_id = p_reserva_id AND tipo = 'debito') THEN
    RETURN 'ok';
  END IF;

  IF v_status IS DISTINCT FROM 'activo' THEN
    RETURN 'cuenta_' || COALESCE(v_status, 'desconocida');
  END IF;

  SELECT status, periodo_actual_fin INTO v_mem
  FROM membresias
  WHERE usuario_id = p_usuario_id AND status IN ('trialing', 'activa', 'past_due')
  ORDER BY created_at DESC
  LIMIT 1;
  IF v_mem IS NULL THEN
    RETURN 'sin_membresia';
  END IF;
  IF v_mem.periodo_actual_fin IS NOT NULL AND v_mem.periodo_actual_fin < now() THEN
    RETURN 'vencida';
  END IF;
  IF v_mem.status = 'past_due' THEN
    RETURN 'pago_pendiente';
  END IF;
  RETURN 'ok';
END;
$$;
REVOKE ALL ON FUNCTION _estado_membresia_checkin(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _estado_membresia_checkin(uuid, uuid) TO service_role;

-- ── 2. Check-in manual ─────────────────────────────────────────────────────
-- Política final (decisión de David, 2026-09-27):
--   · QR: revocado y sancionado → NO entra (ver §1).
--   · Manual, REVOCADO → NO entra. Trigger BEFORE: el UPDATE a 'completada' se
--     rechaza y la transacción entera se revierte (no queda ningún check-in).
--     Cubre check_in_manual_atomic y cualquier otro ingreso manual (p. ej. la
--     corrección "sí asistió" de reception-marcar-asistio).
--   · Manual, SANCIONADO u otro estado distinto de 'ok' → recepción puede dar
--     ingreso por excepción; el RPC devuelve el estado para el aviso en pantalla
--     y el trigger AFTER deja `checkin_manual_con_restriccion` (override = true).
CREATE OR REPLACE FUNCTION reservas_bloquear_checkin_revocado()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM usuarios WHERE id = NEW.usuario_id AND status = 'revocado') THEN
    RAISE EXCEPTION 'EKKO_CUENTA_REVOCADA: El acceso de esta cuenta fue revocado: no se puede registrar el ingreso. Solo un admin puede restaurarlo.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION reservas_bloquear_checkin_revocado() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_bloquear_checkin_revocado ON reservas;
CREATE TRIGGER trg_bloquear_checkin_revocado
  BEFORE UPDATE OF status ON reservas
  FOR EACH ROW
  WHEN (NEW.status = 'completada' AND OLD.status IS DISTINCT FROM 'completada' AND NEW.check_in_method = 'manual')
  EXECUTE FUNCTION reservas_bloquear_checkin_revocado();

CREATE OR REPLACE FUNCTION reservas_auditar_checkin_manual()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estado text;
  v_actor_rol text;
BEGIN
  v_estado := _estado_membresia_checkin(NEW.usuario_id, NEW.id);
  IF v_estado <> 'ok' THEN
    SELECT rol INTO v_actor_rol FROM usuarios WHERE id = NEW.check_in_by;
    INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, metadata)
    VALUES (NEW.tenant_id, NEW.check_in_by, COALESCE(v_actor_rol, 'sistema'), 'checkin_manual_con_restriccion',
            'usuario', NEW.usuario_id,
            jsonb_build_object('reserva_status', OLD.status),
            jsonb_build_object('reserva_status', NEW.status, 'membresia_estado', v_estado),
            jsonb_build_object('reserva_id', NEW.id, 'folio', NEW.folio, 'override', true));
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION reservas_auditar_checkin_manual() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_auditar_checkin_manual ON reservas;
CREATE TRIGGER trg_auditar_checkin_manual
  AFTER UPDATE OF status ON reservas
  FOR EACH ROW
  WHEN (NEW.status = 'completada' AND OLD.status IS DISTINCT FROM 'completada' AND NEW.check_in_method = 'manual')
  EXECUTE FUNCTION reservas_auditar_checkin_manual();

-- ── 3. Revocación persistente ───────────────────────────────────────────────
-- Recrea usuarios_sancion_manda (20260925100000:47-70). Antes solo se impedía
-- revocado→activo cuando cambiaba membresia_activa_id; la reanudación de una
-- pausa (mismo id), la baja inmediata y el sync de Stripe la pisaban.
-- Ahora: un `revocado` se queda `revocado` salvo que la transacción haya pasado
-- por `restaurar_acceso_revocado` (bandera local `ekko.restaurar_revocado`).
CREATE OR REPLACE FUNCTION usuarios_sancion_manda()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'revocado'
     AND NEW.status IS DISTINCT FROM 'revocado'
     AND COALESCE(current_setting('ekko.restaurar_revocado', true), '') <> 'on' THEN
    NEW.status := 'revocado';
  END IF;

  IF NEW.sancionado_at IS NOT NULL AND NEW.status NOT IN ('suspendido', 'revocado') THEN
    NEW.status := 'suspendido';
  END IF;

  RETURN NEW;
END;
$$;

-- Única vía para levantar una revocación. La llama reception-update-member
-- (service_role) cuando un ADMIN cambia el estado de una cuenta revocada.
CREATE OR REPLACE FUNCTION restaurar_acceso_revocado(
  p_usuario_id uuid,
  p_actor_id uuid,
  p_status text,
  p_motivo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
  v_target usuarios;
  v_final text;
BEGIN
  IF p_status NOT IN ('activo', 'pendiente_pago') THEN
    RAISE EXCEPTION 'EKKO_STATUS_INVALIDO: Solo se restaura a activo o pendiente de pago';
  END IF;
  IF COALESCE(length(trim(p_motivo)), 0) < 3 THEN
    RAISE EXCEPTION 'EKKO_MOTIVO_REQUERIDO: Indica el motivo';
  END IF;

  SELECT * INTO v_actor FROM usuarios WHERE id = p_actor_id;
  IF v_actor.id IS NULL OR v_actor.rol <> 'admin' OR v_actor.status <> 'activo' THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin activo puede restaurar un acceso revocado';
  END IF;

  SELECT * INTO v_target FROM usuarios WHERE id = p_usuario_id FOR UPDATE;
  IF v_target.id IS NULL OR v_target.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Cuenta no encontrada o de otro estudio';
  END IF;
  IF v_target.status <> 'revocado' THEN
    RAISE EXCEPTION 'EKKO_NO_REVOCADO: La cuenta no está revocada';
  END IF;

  PERFORM set_config('ekko.restaurar_revocado', 'on', true);
  UPDATE usuarios SET status = p_status WHERE id = p_usuario_id;
  PERFORM set_config('ekko.restaurar_revocado', 'off', true);

  -- Estado REAL: una sanción vigente la deja en 'suspendido' (trigger).
  SELECT status INTO v_final FROM usuarios WHERE id = p_usuario_id;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo)
  VALUES (v_target.tenant_id, v_actor.id, v_actor.rol, 'acceso_restaurado', 'usuario', p_usuario_id,
          jsonb_build_object('status', 'revocado'),
          jsonb_build_object('status', v_final),
          trim(p_motivo));

  RETURN jsonb_build_object('success', true, 'status', v_final);
END;
$$;
REVOKE ALL ON FUNCTION restaurar_acceso_revocado(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION restaurar_acceso_revocado(uuid, uuid, text, text) TO service_role;

-- ── 4. sync_membresia_stripe: sin resurrección, orden de eventos correcto ────
-- Cuerpo de 20260920100000:27-126. Cambios:
--   · FOR UPDATE sobre la membresía (serializa con las RPC de staff).
--   · Orden: se descarta solo un evento ESTRICTAMENTE más viejo que el último
--     aplicado. Antes `<=` tiraba un evento distinto del mismo segundo (p. ej.
--     invoice.paid y customer.subscription.updated). La idempotencia por evento
--     la da `stripe_webhook_events` (PK = id del evento), no el timestamp.
--     Ambigüedad inevitable: `event.created` tiene resolución de 1 s; dos
--     eventos distintos del mismo segundo se aplican en orden de llegada.
--   · Estados terminales locales (`cancelada`, `expirada`): el evento no los
--     cambia. Si Stripe dice que la suscripción está viva, se registra
--     `stripe_estado_contradictorio` y se responde success (sin reintentos).
CREATE OR REPLACE FUNCTION sync_membresia_stripe(
  p_stripe_subscription_id text,
  p_estado text,
  p_periodo_fin timestamptz DEFAULT NULL,
  p_cancel_at_period_end boolean DEFAULT NULL,
  p_event_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem membresias;
  v_now timestamptz := now();
  v_new_status text;
  v_otra_viva boolean;
BEGIN
  SELECT * INTO v_mem
  FROM membresias
  WHERE stripe_subscription_id = p_stripe_subscription_id
  FOR UPDATE;

  IF v_mem.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'membresia_no_encontrada');
  END IF;

  -- Guardia de orden: ignorar eventos ESTRICTAMENTE más viejos que el último aplicado.
  IF p_event_at IS NOT NULL
     AND v_mem.last_sub_event_at IS NOT NULL
     AND p_event_at < v_mem.last_sub_event_at THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'evento_viejo');
  END IF;

  v_new_status := CASE p_estado
    WHEN 'activa'    THEN 'activa'
    WHEN 'past_due'  THEN 'past_due'
    WHEN 'pausada'   THEN 'pausada'
    WHEN 'cancelada' THEN 'cancelada'
    ELSE v_mem.status
  END;

  -- Terminal local: no resucita ni se reescribe.
  IF v_mem.status IN ('cancelada', 'expirada') THEN
    IF v_new_status IN ('activa', 'past_due', 'pausada', 'trialing') THEN
      INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, metadata)
      VALUES (v_mem.tenant_id, NULL, 'sistema', 'stripe_estado_contradictorio', 'usuario', v_mem.usuario_id,
              jsonb_build_object('membresia_status', v_mem.status),
              jsonb_build_object('stripe_estado', v_new_status),
              jsonb_build_object('membresia_id', v_mem.id,
                                 'stripe_subscription_id', v_mem.stripe_subscription_id,
                                 'event_at', p_event_at));
      RETURN jsonb_build_object('success', true, 'ignorado', 'membresia_terminal',
                                'conflicto', true, 'membresia_id', v_mem.id, 'estado', v_mem.status);
    END IF;
    RETURN jsonb_build_object('success', true, 'ignorado', 'membresia_terminal',
                              'conflicto', false, 'membresia_id', v_mem.id, 'estado', v_mem.status);
  END IF;

  UPDATE membresias SET
    status                = v_new_status,
    periodo_actual_fin    = COALESCE(p_periodo_fin, periodo_actual_fin),
    cancel_at_period_end  = COALESCE(p_cancel_at_period_end, cancel_at_period_end),
    pausada_at            = CASE WHEN v_new_status = 'pausada' THEN COALESCE(pausada_at, v_now)
                                 WHEN v_new_status = 'activa' THEN NULL ELSE pausada_at END,
    cancelada_at          = CASE WHEN v_new_status = 'cancelada'
                                 THEN COALESCE(cancelada_at, v_now) ELSE cancelada_at END,
    cancelada_efectiva_at = CASE WHEN v_new_status = 'cancelada'
                                 THEN v_now ELSE cancelada_efectiva_at END,
    last_sub_event_at     = GREATEST(COALESCE(p_event_at, v_now), COALESCE(last_sub_event_at, '-infinity')),
    updated_at            = v_now
  WHERE id = v_mem.id;

  -- Acceso del miembro (sin cambios respecto a 20260920100000; la revocación y
  -- la sanción las protege el trigger trg_sancion_manda).
  IF v_new_status IN ('activa', 'past_due') THEN
    UPDATE usuarios SET status = 'activo'
    WHERE id = v_mem.usuario_id
      AND (status IN ('cancelado', 'pendiente_pago', 'pendiente_onboarding')
           OR (status = 'suspendido' AND v_mem.status = 'pausada'));
  ELSIF v_new_status = 'pausada' THEN
    UPDATE usuarios SET status = 'suspendido'
    WHERE id = v_mem.usuario_id AND status = 'activo';
  ELSIF v_new_status = 'cancelada' THEN
    SELECT EXISTS (
      SELECT 1 FROM membresias
      WHERE usuario_id = v_mem.usuario_id
        AND id <> v_mem.id
        AND status IN ('trialing', 'activa', 'past_due', 'pausada')
    ) INTO v_otra_viva;

    IF v_otra_viva THEN
      RETURN jsonb_build_object(
        'success', true, 'estado', v_new_status, 'membresia_id', v_mem.id,
        'usuario_intacto', true
      );
    END IF;

    UPDATE usuarios
    SET status = 'cancelado', membresia_activa_id = NULL, membresia_tier = NULL
    WHERE id = v_mem.usuario_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'estado', v_new_status, 'membresia_id', v_mem.id);
END;
$$;
REVOKE EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION sync_membresia_stripe(text, text, timestamptz, boolean, timestamptz) TO service_role;

-- ── 5. staff_pausar_membresia: el audit registra el estado REAL ─────────────
-- Cuerpo de 20260920160000:25-116. Único cambio: `usuario_status` en `despues`
-- se relee tras el UPDATE (antes decía 'activo'/'suspendido' aunque el trigger
-- dejara 'suspendido' por sanción o 'revocado').
CREATE OR REPLACE FUNCTION staff_pausar_membresia(p_usuario_id uuid, p_pausar boolean, p_motivo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_usuario usuarios;
  v_mem membresias;
  v_nuevo text;
  v_now timestamptz := now();
  v_fin_nuevo timestamptz;
  v_status_final text;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden pausar membresías';
  END IF;
  IF COALESCE(length(trim(p_motivo)), 0) < 3 THEN
    RAISE EXCEPTION 'EKKO_MOTIVO_REQUERIDO: Indica el motivo';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro no encontrado o de otro estudio';
  END IF;

  IF p_pausar THEN
    SELECT * INTO v_mem FROM membresias
    WHERE usuario_id = p_usuario_id AND status IN ('trialing', 'activa', 'past_due')
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF v_mem.id IS NULL THEN
      RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: El miembro no tiene una membresía vigente que pausar';
    END IF;
    v_nuevo := 'pausada';
    UPDATE membresias
    SET status = 'pausada', pausada_at = v_now, pausada_desde_status = v_mem.status, updated_at = v_now
    WHERE id = v_mem.id;
    UPDATE usuarios SET status = 'suspendido' WHERE id = p_usuario_id;
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (v_tenant, p_usuario_id, 'membresia_pausada', 'Tu membresía está en pausa',
            'Pausamos tu membresía: no se te cobrará ni podrás reservar hasta que se reactive. Pasa a recepción cuando quieras volver.',
            jsonb_build_object('membresia_id', v_mem.id));
  ELSE
    SELECT * INTO v_mem FROM membresias
    WHERE usuario_id = p_usuario_id AND status = 'pausada'
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF v_mem.id IS NULL THEN
      RAISE EXCEPTION 'EKKO_SIN_PAUSA: El miembro no tiene una membresía pausada';
    END IF;
    v_nuevo := CASE WHEN v_mem.pausada_desde_status IN ('trialing', 'activa', 'past_due')
                    THEN v_mem.pausada_desde_status ELSE 'activa' END;
    v_fin_nuevo := v_mem.periodo_actual_fin;
    IF v_mem.stripe_subscription_id IS NULL
       AND v_mem.periodo_actual_fin IS NOT NULL
       AND v_mem.pausada_at IS NOT NULL THEN
      v_fin_nuevo := v_mem.periodo_actual_fin + (v_now - v_mem.pausada_at);
    END IF;
    UPDATE membresias
    SET status = v_nuevo, pausada_at = NULL, pausada_desde_status = NULL,
        periodo_actual_fin = v_fin_nuevo, updated_at = v_now
    WHERE id = v_mem.id;
    UPDATE usuarios SET status = 'activo', membresia_activa_id = v_mem.id WHERE id = p_usuario_id;
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (v_tenant, p_usuario_id, 'membresia_reactivada', 'Tu membresía volvió',
            'Reactivamos tu membresía: ya puedes volver a reservar.',
            jsonb_build_object('membresia_id', v_mem.id));
  END IF;

  SELECT status INTO v_status_final FROM usuarios WHERE id = p_usuario_id;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, CASE WHEN p_pausar THEN 'membresia_pausada' ELSE 'membresia_reactivada' END,
          'usuario', p_usuario_id,
          jsonb_build_object('membresia_status', v_mem.status, 'usuario_status', v_usuario.status,
                             'periodo_actual_fin', v_mem.periodo_actual_fin),
          jsonb_build_object('membresia_status', v_nuevo, 'usuario_status', v_status_final,
                             'periodo_actual_fin', CASE WHEN p_pausar THEN v_mem.periodo_actual_fin ELSE v_fin_nuevo END),
          trim(p_motivo), jsonb_build_object('membresia_id', v_mem.id, 'stripe_subscription_id', v_mem.stripe_subscription_id));

  RETURN jsonb_build_object('success', true, 'membresia_id', v_mem.id, 'status', v_nuevo,
                            'usuario_status', v_status_final,
                            'stripe_subscription_id', v_mem.stripe_subscription_id,
                            'periodo_actual_fin', CASE WHEN p_pausar THEN v_mem.periodo_actual_fin ELSE v_fin_nuevo END);
END;
$$;
REVOKE ALL ON FUNCTION staff_pausar_membresia(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_pausar_membresia(uuid, boolean, text) TO authenticated;

-- ── 6. Auditoría del ciclo de vida con el estado real ───────────────────────
-- Triggers AFTER: ven el valor FINAL (después de trg_sancion_manda y del resto).
-- Cubren todos los escritores —activación, sync de Stripe, pausa, baja, cambio
-- de plan, expiración, revocación, cambio de rol, escrituras de admin por RLS—
-- sin recrear sus funciones. El actor sale de la sesión: NULL + 'sistema' cuando
-- escribe el backend (webhook, cron, service_role).
CREATE OR REPLACE FUNCTION _audit_actor()
RETURNS TABLE (actor_id uuid, actor_rol text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, COALESCE(u.rol, 'sistema')
  FROM (SELECT 1) x
  LEFT JOIN usuarios u ON u.auth_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION _audit_actor() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION usuarios_auditar_estado()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_actor_rol text;
BEGIN
  SELECT actor_id, actor_rol INTO v_actor_id, v_actor_rol FROM _audit_actor();
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, metadata)
  VALUES (NEW.tenant_id, v_actor_id, v_actor_rol, 'cuenta_estado_cambio', 'usuario', NEW.id,
          jsonb_build_object('status', OLD.status, 'rol', OLD.rol, 'sancionado', OLD.sancionado_at IS NOT NULL),
          jsonb_build_object('status', NEW.status, 'rol', NEW.rol, 'sancionado', NEW.sancionado_at IS NOT NULL),
          jsonb_build_object('db_role', current_user));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION usuarios_auditar_estado() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_auditar_estado_cuenta ON usuarios;
CREATE TRIGGER trg_auditar_estado_cuenta
  AFTER UPDATE ON usuarios
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.rol IS DISTINCT FROM NEW.rol
        OR (OLD.sancionado_at IS NULL) IS DISTINCT FROM (NEW.sancionado_at IS NULL))
  EXECUTE FUNCTION usuarios_auditar_estado();

CREATE OR REPLACE FUNCTION membresias_auditar_estado()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_actor_rol text;
  v_tier_antes text;
  v_tier_despues text;
BEGIN
  SELECT actor_id, actor_rol INTO v_actor_id, v_actor_rol FROM _audit_actor();
  SELECT slug INTO v_tier_despues FROM tiers WHERE id = NEW.tier_id;
  IF TG_OP = 'UPDATE' THEN
    SELECT slug INTO v_tier_antes FROM tiers WHERE id = OLD.tier_id;
  END IF;
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, metadata)
  VALUES (NEW.tenant_id, v_actor_id, v_actor_rol, 'membresia_estado_cambio', 'usuario', NEW.usuario_id,
          CASE WHEN TG_OP = 'UPDATE'
               THEN jsonb_build_object('membresia_status', OLD.status, 'tier', v_tier_antes)
               ELSE NULL END,
          jsonb_build_object('membresia_status', NEW.status, 'tier', v_tier_despues,
                             'periodo_actual_fin', NEW.periodo_actual_fin,
                             'creditos_restantes', NEW.creditos_restantes),
          jsonb_build_object('membresia_id', NEW.id, 'operacion', lower(TG_OP),
                             'con_stripe', NEW.stripe_subscription_id IS NOT NULL,
                             'db_role', current_user));
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION membresias_auditar_estado() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_auditar_membresia_alta ON membresias;
CREATE TRIGGER trg_auditar_membresia_alta
  AFTER INSERT ON membresias
  FOR EACH ROW EXECUTE FUNCTION membresias_auditar_estado();

DROP TRIGGER IF EXISTS trg_auditar_membresia_cambio ON membresias;
CREATE TRIGGER trg_auditar_membresia_cambio
  AFTER UPDATE ON membresias
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.tier_id IS DISTINCT FROM NEW.tier_id)
  EXECUTE FUNCTION membresias_auditar_estado();

-- ── 7. Vista de reconciliación (solo lectura) ───────────────────────────────
-- security_invoker: cada quien ve lo que su RLS le permite (admin/recepción su
-- estudio; el miembro, su propia fila). No repara nada. No expone ids de Stripe.
--   divergencias  = el estado derivado contradice a `membresias`.
--   restricciones = cuenta restringida con membresía viva: NO es un error de la
--                   membresía (se conserva), es un acceso bloqueado.
CREATE OR REPLACE VIEW v_reconciliacion_membresia
WITH (security_invoker = true) AS
WITH viva AS (
  SELECT DISTINCT ON (m.usuario_id)
         m.usuario_id, m.id, m.status, m.periodo_actual_fin,
         (m.stripe_subscription_id IS NOT NULL) AS con_stripe, t.slug
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.status IN ('trialing', 'activa', 'past_due', 'pausada')
  ORDER BY m.usuario_id, m.created_at DESC
),
n_vivas AS (
  SELECT usuario_id, count(*) AS n
  FROM membresias
  WHERE status IN ('trialing', 'activa', 'past_due', 'pausada')
  GROUP BY usuario_id
)
SELECT
  u.id                       AS usuario_id,
  u.tenant_id,
  u.rol,
  u.status,
  (u.sancionado_at IS NOT NULL) AS sancionado,
  u.membresia_tier,
  u.membresia_activa_id,
  v.id                       AS membresia_viva_id,
  v.status                   AS membresia_viva_status,
  v.slug                     AS membresia_viva_tier,
  v.periodo_actual_fin       AS membresia_viva_fin,
  array_remove(ARRAY[
    CASE WHEN u.rol = 'miembro' AND u.status = 'activo'
              AND (v.id IS NULL OR v.status = 'pausada'
                   OR (NOT v.con_stripe AND v.periodo_actual_fin < now()))
         THEN 'activo_sin_derecho' END,
    CASE WHEN u.membresia_tier IS NOT NULL AND v.id IS NULL
         THEN 'tier_sin_membresia_viva' END,
    CASE WHEN v.id IS NOT NULL AND u.membresia_activa_id IS NULL
         THEN 'membresia_viva_sin_activa_id' END,
    CASE WHEN u.membresia_activa_id IS NOT NULL
              AND (am.id IS NULL OR am.usuario_id <> u.id
                   OR am.status NOT IN ('trialing', 'activa', 'past_due', 'pausada'))
         THEN 'activa_id_invalido' END,
    CASE WHEN v.id IS NOT NULL AND u.membresia_tier IS DISTINCT FROM v.slug
         THEN 'tier_distinto' END,
    CASE WHEN v.id IS NOT NULL AND NOT v.con_stripe AND v.status <> 'pausada'
              AND v.periodo_actual_fin < now()
         THEN 'membresia_vencida_sin_expirar' END,
    CASE WHEN nv.n > 1 THEN 'varias_membresias_vivas' END,
    CASE WHEN EXISTS (SELECT 1 FROM audit_log a
                      WHERE a.target_tipo = 'usuario' AND a.target_id = u.id
                        AND a.accion = 'stripe_estado_contradictorio')
         THEN 'stripe_contradictorio' END,
    CASE WHEN dp.stripe_customer_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM membresias mc
              WHERE mc.usuario_id = u.id AND mc.stripe_customer_id IS NOT NULL
                AND mc.stripe_customer_id <> dp.stripe_customer_id)
         THEN 'stripe_customer_distinto' END
  ], NULL) AS divergencias,
  array_remove(ARRAY[
    CASE WHEN u.status = 'revocado' AND v.id IS NOT NULL THEN 'revocado_con_membresia_viva' END,
    CASE WHEN u.sancionado_at IS NOT NULL AND v.id IS NOT NULL THEN 'sancionado_con_membresia_viva' END
  ], NULL) AS restricciones
FROM usuarios u
LEFT JOIN viva v ON v.usuario_id = u.id
LEFT JOIN n_vivas nv ON nv.usuario_id = u.id
LEFT JOIN membresias am ON am.id = u.membresia_activa_id
LEFT JOIN usuarios_datos_privados dp ON dp.usuario_id = u.id;

REVOKE ALL ON v_reconciliacion_membresia FROM PUBLIC, anon;
GRANT SELECT ON v_reconciliacion_membresia TO authenticated, service_role;
