-- ============================================================================
-- EKKO-138 · D-03A-1 = A · La pausa del staff es independiente de la sanción
-- ----------------------------------------------------------------------------
-- Causa raíz: `membresias.status = 'pausada'` lo escriben DOS fuentes distintas:
--   · la pausa del staff (`staff_pausar_membresia`), que es INTENCIÓN comercial;
--   · el eco del proveedor: la suspensión por sanción pone `pause_collection` en
--     Stripe y el webhook lo sincroniza como `pausada` (sync_membresia_stripe).
-- Con un solo estado no se puede saber si, al levantar una sanción, hay que
-- reanudar el cobro. `pausada_desde_status` no es autoridad (puede quedar viejo).
--
-- Primitiva mínima: `membresias.pausa_comercial_at` — la INTENCIÓN del staff,
-- durable y del servidor. Una sola columna: quién y por qué ya quedan en
-- audit_log (`membresia_pausada` / `membresia_reactivada`, con actor y motivo).
--   · La pone y la quita SOLO `staff_pausar_membresia` (pausar / reactivar).
--   · El webhook NO la toca: sincroniza hechos del proveedor, no intención.
--   · Levantar la sanción con la intención vigente NO reanuda el cobro: queda una
--     operación `reanudar_cobro` DESCARTADA con motivo `pausa_comercial_vigente`
--     (evidencia de por qué no se reanudó, y cierre del ciclo de la sanción).
--   · Reactivar durante una sanción quita la intención pero NO reanuda el cobro:
--     manda la sanción (se re-asegura su suspensión); el cobro vuelve al levantarla.
--   · Cuenta revocada: sin cambio respecto de R1 (pausar/reactivar no la levantan:
--     usuarios_sancion_manda la mantiene; sus operaciones de cobro se descartan).
--
-- Datos existentes: SIN backfill. La autoridad empieza hacia adelante. En
-- producción (lectura 2026-10-06) hay 0 membresías `pausada`, 0 auditorías de
-- pausa/reactivación y 0 sancionados: no hay historia que interpretar.
-- Sin UPDATE/DELETE de datos de negocio. Cambian de cuerpo, a propósito:
-- `staff_pausar_membresia` (R1), `_reconciliar_cobro_sancion` y
-- `operacion_suscripcion_preparar` (R2-B).
-- Pruebas: src/__tests__/db/ekko138-pausa-comercial.db.test.ts
-- ============================================================================

ALTER TABLE membresias ADD COLUMN IF NOT EXISTS pausa_comercial_at timestamptz;
COMMENT ON COLUMN membresias.pausa_comercial_at IS
  'EKKO-138: intención de pausa COMERCIAL puesta por el staff (no la sanción ni el eco de Stripe). Solo la escribe staff_pausar_membresia.';

-- R1, misma definición más la intención comercial (marcado EKKO-138).
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
  v_solo_intencion boolean := false;
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
    -- EKKO-138: idempotente. Ya hay una pausa comercial vigente → nada que hacer.
    SELECT * INTO v_mem FROM membresias
    WHERE usuario_id = p_usuario_id AND status = 'pausada' AND pausa_comercial_at IS NOT NULL
    ORDER BY created_at DESC LIMIT 1;
    IF v_mem.id IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'idempotente', true, 'membresia_id', v_mem.id, 'status', 'pausada',
                                'usuario_status', v_usuario.status, 'stripe_subscription_id', v_mem.stripe_subscription_id,
                                'periodo_actual_fin', v_mem.periodo_actual_fin);
    END IF;

    SELECT * INTO v_mem FROM membresias
    WHERE usuario_id = p_usuario_id AND status IN ('trialing', 'activa', 'past_due')
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF v_mem.id IS NULL THEN
      -- EKKO-138: ya pausada por el PROVEEDOR (p. ej. eco de la suspensión por
      -- sanción) y sin intención del staff: el staff la declara. Solo intención;
      -- el estado y el cobro ya están en pausa.
      SELECT * INTO v_mem FROM membresias
      WHERE usuario_id = p_usuario_id AND status = 'pausada' AND pausa_comercial_at IS NULL
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
      IF v_mem.id IS NULL THEN
        RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: El miembro no tiene una membresía vigente que pausar';
      END IF;
      v_solo_intencion := true;
    END IF;
    v_nuevo := 'pausada';
    IF v_solo_intencion THEN
      UPDATE membresias SET pausa_comercial_at = v_now, updated_at = v_now WHERE id = v_mem.id;
    ELSE
      UPDATE membresias
      SET status = 'pausada', pausada_at = v_now, pausada_desde_status = v_mem.status,
          pausa_comercial_at = v_now, updated_at = v_now
      WHERE id = v_mem.id;
    END IF;
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
      -- EKKO-138: idempotente. Ya reactivada (viva y sin intención) → nada que hacer.
      SELECT * INTO v_mem FROM membresias
      WHERE usuario_id = p_usuario_id AND status IN ('trialing', 'activa', 'past_due') AND pausa_comercial_at IS NULL
      ORDER BY created_at DESC LIMIT 1;
      IF v_mem.id IS NOT NULL THEN
        RETURN jsonb_build_object('success', true, 'idempotente', true, 'membresia_id', v_mem.id, 'status', v_mem.status,
                                  'usuario_status', v_usuario.status, 'stripe_subscription_id', v_mem.stripe_subscription_id,
                                  'periodo_actual_fin', v_mem.periodo_actual_fin,
                                  'cobro_suspendido_por_sancion', v_usuario.sancionado_at IS NOT NULL);
      END IF;
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
    SET status = v_nuevo, pausada_at = NULL, pausada_desde_status = NULL, pausa_comercial_at = NULL,
        periodo_actual_fin = v_fin_nuevo, updated_at = v_now
    WHERE id = v_mem.id;
    UPDATE usuarios SET status = 'activo', membresia_activa_id = v_mem.id WHERE id = p_usuario_id;
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (v_tenant, p_usuario_id, 'membresia_reactivada', 'Tu membresía volvió',
            'Reactivamos tu membresía: ya puedes volver a reservar.',
            jsonb_build_object('membresia_id', v_mem.id));
    -- EKKO-138: reactivar NO es una vía para saltarse una sanción. Si sigue
    -- vigente, el acceso lo bloquea usuarios_sancion_manda y el cobro queda
    -- suspendido por la sanción (se re-asegura su operación); vuelve al levantarla.
    PERFORM _reconciliar_cobro_sancion(p_usuario_id);
  END IF;

  SELECT status INTO v_status_final FROM usuarios WHERE id = p_usuario_id;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, CASE WHEN p_pausar THEN 'membresia_pausada' ELSE 'membresia_reactivada' END,
          'usuario', p_usuario_id,
          jsonb_build_object('membresia_status', v_mem.status, 'usuario_status', v_usuario.status,
                             'periodo_actual_fin', v_mem.periodo_actual_fin),
          jsonb_build_object('membresia_status', v_nuevo, 'usuario_status', v_status_final,
                             'periodo_actual_fin', CASE WHEN p_pausar THEN v_mem.periodo_actual_fin ELSE v_fin_nuevo END),
          trim(p_motivo), jsonb_build_object('membresia_id', v_mem.id, 'stripe_subscription_id', v_mem.stripe_subscription_id,
                                             -- EKKO-138: qué se declaró y en qué contexto.
                                             'pausa_comercial', p_pausar, 'solo_intencion', v_solo_intencion,
                                             'sancionado', v_usuario.sancionado_at IS NOT NULL));

  RETURN jsonb_build_object('success', true, 'membresia_id', v_mem.id, 'status', v_nuevo,
                            'usuario_status', v_status_final,
                            'stripe_subscription_id', v_mem.stripe_subscription_id,
                            'periodo_actual_fin', CASE WHEN p_pausar THEN v_mem.periodo_actual_fin ELSE v_fin_nuevo END,
                            'cobro_suspendido_por_sancion', (NOT p_pausar) AND v_usuario.sancionado_at IS NOT NULL);
END;
$$;
REVOKE ALL ON FUNCTION staff_pausar_membresia(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_pausar_membresia(uuid, boolean, text) TO authenticated;

-- R2-B, misma definición más la pausa comercial (marcado EKKO-138).
CREATE OR REPLACE FUNCTION _reconciliar_cobro_sancion(p_usuario_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_u        usuarios;
  v_m        record;
  v_ultima   record;
  v_creadas  integer := 0;
  v_n        integer;
BEGIN
  SELECT * INTO v_u FROM usuarios WHERE id = p_usuario_id;
  IF v_u.id IS NULL THEN
    RETURN 0;
  END IF;

  -- Revocada: la suscripción se CANCELA (otra operación); suspender/reanudar sobran.
  IF v_u.status = 'revocado' THEN
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'descartada', motivo_descarte = 'cuenta_revocada'
    WHERE usuario_id = p_usuario_id AND tipo IN ('suspender_cobro', 'reanudar_cobro')
      AND estado IN ('pendiente', 'fallida');
    RETURN 0;
  END IF;

  FOR v_m IN
    SELECT m.id, m.tenant_id, m.status, m.stripe_subscription_id, m.pausa_comercial_at
    FROM membresias m
    WHERE m.usuario_id = p_usuario_id AND m.stripe_subscription_id IS NOT NULL
      AND m.status IN ('trialing', 'activa', 'past_due', 'pausada')
  LOOP
    -- Lo último que cerró el ciclo de cobro de la sanción: lo APLICADO en el
    -- proveedor o (EKKO-138) una reanudación descartada por pausa comercial, que
    -- cede el control del cobro a la pausa del staff.
    SELECT o.id, o.tipo INTO v_ultima
    FROM stripe_operaciones_suscripcion o
    WHERE o.membresia_id = v_m.id AND o.tipo IN ('suspender_cobro', 'reanudar_cobro')
      AND (o.estado = 'aplicada'
           OR (o.estado = 'descartada' AND o.motivo_descarte = 'pausa_comercial_vigente'))
    ORDER BY COALESCE(o.aplicada_at, o.updated_at) DESC, o.created_at DESC
    LIMIT 1;

    IF v_u.sancionado_at IS NOT NULL THEN
      UPDATE stripe_operaciones_suscripcion
      SET estado = 'descartada', motivo_descarte = 'sancion_vigente'
      WHERE membresia_id = v_m.id AND tipo = 'reanudar_cobro' AND estado IN ('pendiente', 'fallida');

      -- Solo se suspende lo que EKKO no tenía ya en pausa por otra razón.
      IF v_ultima.tipo IS DISTINCT FROM 'suspender_cobro'
         AND v_m.status IN ('trialing', 'activa', 'past_due')
         AND NOT EXISTS (SELECT 1 FROM stripe_operaciones_suscripcion
                         WHERE membresia_id = v_m.id AND tipo = 'suspender_cobro' AND estado IN ('pendiente', 'fallida')) THEN
        INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
        VALUES (v_m.tenant_id, p_usuario_id, v_m.id, v_m.stripe_subscription_id, 'suspender_cobro', 'sancion',
                'suspender:' || v_m.id || ':' || floor(extract(epoch FROM v_u.sancionado_at) * 1000)::bigint)
        ON CONFLICT (operation_key) DO NOTHING;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_creadas := v_creadas + v_n;
      END IF;
    ELSE
      -- Sin sanción: una suspensión que no llegó a aplicarse ya no hace falta.
      UPDATE stripe_operaciones_suscripcion
      SET estado = 'descartada', motivo_descarte = 'sancion_levantada'
      WHERE membresia_id = v_m.id AND tipo = 'suspender_cobro' AND estado IN ('pendiente', 'fallida');

      -- Y si lo último aplicado fue una suspensión, se reanuda (una vez por suspensión)…
      IF v_ultima.tipo = 'suspender_cobro' THEN
        IF v_m.pausa_comercial_at IS NOT NULL THEN
          -- EKKO-138 (D-03A-1 = A): …salvo que el staff haya pausado la membresía:
          -- esa pausa es independiente y sigue vigente. Se deja escrito por qué no
          -- se reanudó; el cobro vuelve solo con la reactivación explícita.
          INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa,
                                                      operation_key, estado, motivo_descarte)
          VALUES (v_m.tenant_id, p_usuario_id, v_m.id, v_m.stripe_subscription_id, 'reanudar_cobro', 'levantar_sancion',
                  'reanudar:' || v_ultima.id, 'descartada', 'pausa_comercial_vigente')
          ON CONFLICT (operation_key) DO NOTHING;
        ELSE
          INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
          VALUES (v_m.tenant_id, p_usuario_id, v_m.id, v_m.stripe_subscription_id, 'reanudar_cobro', 'levantar_sancion',
                  'reanudar:' || v_ultima.id)
          ON CONFLICT (operation_key) DO NOTHING;
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_creadas := v_creadas + v_n;
        END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN v_creadas;
END;
$$;
REVOKE ALL ON FUNCTION _reconciliar_cobro_sancion(uuid) FROM PUBLIC, anon, authenticated;

-- R2-B, misma definición más la pausa comercial en la revalidación (EKKO-138).
CREATE OR REPLACE FUNCTION operacion_suscripcion_preparar(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o       stripe_operaciones_suscripcion;
  v_u       usuarios;
  v_m       membresias;
  v_motivo  text;
BEGIN
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE id = p_id FOR UPDATE;
  IF v_o.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_NO_EXISTE: Operación no encontrada';
  END IF;
  IF v_o.estado NOT IN ('pendiente', 'fallida') THEN
    RETURN jsonb_build_object('ejecutar', false, 'estado', v_o.estado, 'motivo', 'ya_' || v_o.estado);
  END IF;

  SELECT * INTO v_u FROM usuarios WHERE id = v_o.usuario_id;
  SELECT * INTO v_m FROM membresias WHERE id = v_o.membresia_id;

  IF v_o.tipo = 'suspender_cobro' THEN
    v_motivo := CASE
      WHEN v_u.id IS NULL OR v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_u.status = 'revocado' THEN 'cuenta_revocada'
      WHEN v_u.sancionado_at IS NULL THEN 'sancion_levantada'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
    END;
  ELSIF v_o.tipo = 'reanudar_cobro' THEN
    -- No se resucita nada: solo se reanuda si TODO sigue siendo válido.
    v_motivo := CASE
      WHEN v_u.id IS NULL OR v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_u.status = 'revocado' THEN 'cuenta_revocada'
      WHEN v_u.sancionado_at IS NOT NULL THEN 'sancion_vigente'
      -- EKKO-138: el staff pausó la membresía mientras esta reanudación esperaba.
      WHEN v_m.pausa_comercial_at IS NOT NULL THEN 'pausa_comercial_vigente'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
    END;
  ELSE
    -- cancelar: no tocar una suscripción que hoy sostiene OTRA membresía viva.
    v_motivo := CASE
      WHEN EXISTS (SELECT 1 FROM membresias x
                   WHERE x.stripe_subscription_id = v_o.stripe_subscription_id
                     AND x.id IS DISTINCT FROM v_o.membresia_id
                     AND x.status IN ('trialing', 'activa', 'past_due', 'pausada'))
        THEN 'suscripcion_en_uso_por_otra_membresia'
    END;
  END IF;

  IF v_motivo IS NOT NULL THEN
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'descartada', motivo_descarte = v_motivo
    WHERE id = v_o.id;
    RETURN jsonb_build_object('ejecutar', false, 'estado', 'descartada', 'motivo', v_motivo);
  END IF;

  UPDATE stripe_operaciones_suscripcion
  SET intentos = intentos + 1, ultimo_intento_at = now()
  WHERE id = v_o.id
  RETURNING * INTO v_o;

  RETURN jsonb_build_object(
    'ejecutar', true, 'id', v_o.id, 'tipo', v_o.tipo, 'tenant_id', v_o.tenant_id,
    'stripe_subscription_id', v_o.stripe_subscription_id,
    -- Llave de idempotencia del proveedor: misma operación + mismo intento.
    'idempotency_key', 'ekko:' || v_o.operation_key || ':' || v_o.intentos,
    'intento', v_o.intentos);
END;
$$;
REVOKE ALL ON FUNCTION operacion_suscripcion_preparar(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION operacion_suscripcion_preparar(uuid) TO service_role;
