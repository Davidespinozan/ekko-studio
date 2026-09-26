-- ============================================================================
-- Pausa que no quema créditos · devolución al saldo correcto
-- ============================================================================
-- M4a · Reanudar no extendía la vigencia. Un paquete de 30 días pausado 3 semanas
--   volvía casi vencido (o vencido: el siguiente cron lo expiraba y le ponía los
--   créditos en cero). Pausar es justo para NO perder días. Al reanudar se suma
--   a `periodo_actual_fin` el tiempo que estuvo en pausa — solo en membresías SIN
--   suscripción Stripe: con Stripe el periodo lo dicta Stripe. (SALA 20260613000700.)
--   De paso: al pausar se guarda el status previo (`pausada_desde_status`) y al
--   reanudar se vuelve a ESE status: una `past_due` pausada sigue debiendo, no
--   se blanquea a `activa`.
--
-- D10 · La devolución al cancelar una reserva iba a "la membresía viva más
--   reciente", que (a) no veía una membresía en pausa → el crédito se perdía en
--   silencio, incluso cuando cancelaba el estudio; y (b) podía no ser la que se
--   debitó. Ahora vuelve a la membresía debitada si sigue viva o en pausa; si
--   ya no, a la viva actual.
--
-- Tests conductuales: src/__tests__/db/membresias-dinero.db.test.ts
-- ============================================================================

ALTER TABLE membresias ADD COLUMN IF NOT EXISTS pausada_desde_status text;

-- ── 1. staff_pausar_membresia (cuerpo de 20260821200000:25-94) ───────────────
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
    -- Vuelve al status que tenía (una past_due sigue debiendo); default activa.
    v_nuevo := CASE WHEN v_mem.pausada_desde_status IN ('trialing', 'activa', 'past_due')
                    THEN v_mem.pausada_desde_status ELSE 'activa' END;
    -- Los días en pausa no cuentan (sin Stripe; con Stripe el periodo es de Stripe).
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

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, CASE WHEN p_pausar THEN 'membresia_pausada' ELSE 'membresia_reactivada' END,
          'usuario', p_usuario_id,
          jsonb_build_object('membresia_status', v_mem.status, 'usuario_status', v_usuario.status,
                             'periodo_actual_fin', v_mem.periodo_actual_fin),
          jsonb_build_object('membresia_status', v_nuevo, 'usuario_status', CASE WHEN p_pausar THEN 'suspendido' ELSE 'activo' END,
                             'periodo_actual_fin', CASE WHEN p_pausar THEN v_mem.periodo_actual_fin ELSE v_fin_nuevo END),
          trim(p_motivo), jsonb_build_object('membresia_id', v_mem.id, 'stripe_subscription_id', v_mem.stripe_subscription_id));

  RETURN jsonb_build_object('success', true, 'membresia_id', v_mem.id, 'status', v_nuevo,
                            'stripe_subscription_id', v_mem.stripe_subscription_id,
                            'periodo_actual_fin', CASE WHEN p_pausar THEN v_mem.periodo_actual_fin ELSE v_fin_nuevo END);
END;
$$;

REVOKE ALL ON FUNCTION staff_pausar_membresia(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_pausar_membresia(uuid, boolean, text) TO authenticated;

-- ── 2. creditos_devolver_al_cancelar (cuerpo de 20260821110000) ──────────────
CREATE OR REPLACE FUNCTION creditos_devolver_al_cancelar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem       membresias;
  v_min_horas numeric;
  v_a_tiempo  boolean;
  v_debito    integer;  -- delta del débito (negativo)
  v_debito_mem uuid;    -- membresía que pagó la reserva
  v_devolver  integer;  -- monto a devolver (positivo)
BEGIN
  IF NOT (OLD.status = 'confirmada' AND NEW.status IN ('cancelada', 'cancelada_admin')) THEN
    RETURN NEW;
  END IF;

  -- Monto realmente debitado por esta reserva (si lo hubo y no se devolvió ya).
  SELECT delta, membresia_id INTO v_debito, v_debito_mem
  FROM membresia_movimientos
  WHERE reserva_id = NEW.id AND tipo = 'debito'
  LIMIT 1;

  IF v_debito IS NULL THEN
    RETURN NEW;  -- no hubo débito (plan por tiempo, o sin créditos)
  END IF;
  IF EXISTS (SELECT 1 FROM membresia_movimientos WHERE reserva_id = NEW.id AND tipo = 'devolucion') THEN
    RETURN NEW;
  END IF;

  -- Misma regla que cancelar_reserva_atomic: la ventana de CANCELACIÓN.
  SELECT COALESCE((config->'reserva'->>'cancelacion_min_horas_antes')::numeric, 0)
    INTO v_min_horas FROM tenants WHERE id = NEW.tenant_id;
  v_a_tiempo := (v_min_horas <= 0)
             OR (NEW.slot_inicio > now() + (v_min_horas || ' hours')::interval);

  -- El miembro que cancela tarde pierde el crédito; el estudio siempre devuelve.
  IF NEW.status <> 'cancelada_admin' AND NOT v_a_tiempo THEN
    RETURN NEW;
  END IF;

  v_devolver := -v_debito;  -- ej. débito -2 → devuelve 2

  -- D10: primero la membresía que se debitó, si sigue viva o en pausa…
  SELECT m.* INTO v_mem
  FROM membresias m
  WHERE m.id = v_debito_mem
    AND m.status IN ('trialing', 'activa', 'past_due', 'pausada')
  FOR UPDATE;

  -- …si ya no (se reemplazó por otro plan), la viva actual del miembro.
  IF v_mem.id IS NULL THEN
    SELECT m.* INTO v_mem
    FROM membresias m
    WHERE m.usuario_id = NEW.usuario_id
      AND m.status IN ('trialing', 'activa', 'past_due', 'pausada')
    ORDER BY m.created_at DESC
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF v_mem.id IS NULL OR v_mem.creditos_restantes IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE membresias
  SET creditos_restantes = creditos_restantes + v_devolver, updated_at = now()
  WHERE id = v_mem.id;

  INSERT INTO membresia_movimientos (
    tenant_id, membresia_id, usuario_id, reserva_id, tipo, delta, saldo_after, motivo
  ) VALUES (
    NEW.tenant_id, v_mem.id, NEW.usuario_id, NEW.id, 'devolucion', v_devolver,
    v_mem.creditos_restantes + v_devolver,
    CASE WHEN NEW.status = 'cancelada_admin'
         THEN 'Devolución (cancelado por el estudio)'
         ELSE 'Devolución (cancelación a tiempo)' END
  );

  RETURN NEW;
END;
$$;
