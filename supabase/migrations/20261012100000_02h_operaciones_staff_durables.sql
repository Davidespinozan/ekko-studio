-- ============================================================================
-- PKG-02H · OPERACIONES DE COBRO DEL STAFF DURABLES (pausa, reactivación, baja al
-- fin del periodo)
-- ----------------------------------------------------------------------------
-- Residual real tras R1, R2-A/B, EKKO-138, PKG-03A y PKG-03B: tres operaciones del
-- staff seguían mutando Stripe PRIMERO y escribiendo EKKO después, sin intención
-- durable ni llave estable: `stripe-pausar-membresia` (pausar / reactivar) y
-- `staff-cancelar-membresia` al fin del periodo. Si Stripe aplicaba y el proceso
-- moría (o la RPC fallaba y el rollback también), nadie sabía qué había pasado y
-- un reintento repetía la mutación.
--
-- Invariante objetivo: UNA operación lógica del staff → UNA intención durable local
-- → como mucho UN efecto en Stripe → resultado durable → reintento seguro →
-- fallo reconciliable. Se reutiliza la primitiva de R2-B
-- (`stripe_operaciones_suscripcion` + ejecutor), no una tabla nueva:
--   · causas nuevas `pausa_staff`, `reactivacion_staff`, `baja_fin_periodo`;
--   · tipo nuevo `cancelar_fin_periodo` (cancel_at_period_end = true);
--   · las RPC crean la operación en la MISMA transacción que la transición local,
--     con identidad por operación lógica (`pausar_staff:<membresía>:<pausa>`,
--     `reactivar_staff:<membresía>:<pausa que se levanta>`, `cancelar_fin:<membresía>`);
--   · el ejecutor revalida por causa antes de llamar a Stripe (una pausa que ya se
--     reactivó se descarta; una reactivación con sanción vigente o pausa comercial
--     vigente se descarta: EKKO-138/139 intactos).
-- La función de Netlify pasa a RPC primero y ejecutor después (el orden de R2-B).
-- Cambian de cuerpo, a propósito: `staff_pausar_membresia` (EKKO-138),
-- `staff_cancelar_membresia` (01Q), `_reconciliar_cobro_sancion` y
-- `operacion_suscripcion_preparar` (EKKO-138), `operacion_suscripcion_resultado`
-- (03A, solo el texto del aviso). Sin datos.
-- Pruebas: src/__tests__/db/02h-operaciones-staff.db.test.ts
-- ============================================================================

ALTER TABLE stripe_operaciones_suscripcion DROP CONSTRAINT IF EXISTS stripe_operaciones_suscripcion_tipo_check;
ALTER TABLE stripe_operaciones_suscripcion ADD CONSTRAINT stripe_operaciones_suscripcion_tipo_check
  CHECK (tipo IN ('suspender_cobro', 'reanudar_cobro', 'cancelar_suscripcion', 'cancelar_fin_periodo'));
ALTER TABLE stripe_operaciones_suscripcion DROP CONSTRAINT IF EXISTS stripe_operaciones_suscripcion_causa_check;
ALTER TABLE stripe_operaciones_suscripcion ADD CONSTRAINT stripe_operaciones_suscripcion_causa_check
  CHECK (causa IN ('sancion', 'levantar_sancion', 'revocacion', 'baja_inmediata', 'pausa_staff', 'reactivacion_staff', 'baja_fin_periodo'));
COMMENT ON TABLE stripe_operaciones_suscripcion IS
  'R2-B/01P + PKG-02H: operaciones de cobro que EKKO debe aplicar en Stripe (suspender, reanudar, cancelar, cancelar al fin del periodo) con su resultado. Evidencia durable y reintentable; una fila por operación lógica.';

-- EKKO-138, misma definición más la operación durable (marcado PKG-02H).
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
  v_pausa_previa timestamptz;
  v_op_creada boolean := false;
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
    -- PKG-02H: la pausa del cobro en Stripe es una OPERACIÓN durable (misma
    -- transacción que la intención), con identidad por pausa lógica. El
    -- ejecutor la aplica después; si Stripe falla queda `fallida`, visible en
    -- Operación y reintentable. Una reanudación que esperaba ya no procede.
    IF v_mem.stripe_subscription_id IS NOT NULL THEN
      UPDATE stripe_operaciones_suscripcion
      SET estado = 'descartada', motivo_descarte = 'pausa_comercial'
      WHERE membresia_id = v_mem.id AND tipo = 'reanudar_cobro' AND estado IN ('pendiente', 'fallida');
      INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
      VALUES (v_tenant, p_usuario_id, v_mem.id, v_mem.stripe_subscription_id, 'suspender_cobro', 'pausa_staff',
              'pausar_staff:' || v_mem.id || ':' || floor(extract(epoch FROM v_now) * 1000)::bigint)
      ON CONFLICT (operation_key) DO NOTHING;
      v_op_creada := FOUND;
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
    v_pausa_previa := COALESCE(v_mem.pausa_comercial_at, v_mem.pausada_at, v_now);
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
    -- PKG-02H: la pausa del staff que no llegó a aplicarse ya no hace falta; y si
    -- no hay sanción, la reanudación del cobro es una operación durable con
    -- identidad por pausa lógica (una reanudación por pausa). Va ANTES del UPDATE de
    -- usuarios: su trigger llama a _reconciliar_cobro_sancion, que no debe duplicarla.
    IF v_mem.stripe_subscription_id IS NOT NULL THEN
      UPDATE stripe_operaciones_suscripcion
      SET estado = 'descartada', motivo_descarte = 'reactivada'
      WHERE membresia_id = v_mem.id AND tipo = 'suspender_cobro' AND causa = 'pausa_staff' AND estado IN ('pendiente', 'fallida');
      IF v_usuario.sancionado_at IS NULL THEN
        INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
        VALUES (v_tenant, p_usuario_id, v_mem.id, v_mem.stripe_subscription_id, 'reanudar_cobro', 'reactivacion_staff',
                'reactivar_staff:' || v_mem.id || ':' || floor(extract(epoch FROM v_pausa_previa) * 1000)::bigint)
        ON CONFLICT (operation_key) DO NOTHING;
        v_op_creada := FOUND;
      END IF;
    END IF;
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
                            'cobro_suspendido_por_sancion', (NOT p_pausar) AND v_usuario.sancionado_at IS NOT NULL,
                            'operacion_cobro', v_op_creada);
END;
$$;
REVOKE ALL ON FUNCTION staff_pausar_membresia(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_pausar_membresia(uuid, boolean, text) TO authenticated;

-- 01Q, misma definición más la operación durable al fin del periodo (marcado PKG-02H).
CREATE OR REPLACE FUNCTION staff_cancelar_membresia(p_usuario_id uuid, p_inmediata boolean, p_motivo text)
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
  v_now timestamptz := now();
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden dar de baja una membresía';
  END IF;
  IF COALESCE(length(trim(p_motivo)), 0) < 5 THEN
    RAISE EXCEPTION 'EKKO_MOTIVO_REQUERIDO: Indica el motivo de la baja';
  END IF;

  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro no encontrado o de otro estudio';
  END IF;

  SELECT * INTO v_mem FROM membresias
  WHERE usuario_id = p_usuario_id AND status IN ('trialing', 'activa', 'past_due', 'pausada')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_mem.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: El miembro no tiene una membresía vigente que dar de baja';
  END IF;

  IF COALESCE(p_inmediata, false) THEN
    IF COALESCE(v_mem.creditos_restantes, 0) > 0 THEN
      INSERT INTO membresia_movimientos (tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo)
      VALUES (v_tenant, v_mem.id, p_usuario_id, 'ajuste', -v_mem.creditos_restantes, 0, 'Baja de la membresía: ' || trim(p_motivo));
    END IF;
    UPDATE membresias
    SET status = 'cancelada', cancelada_at = v_now, cancelada_efectiva_at = v_now,
        pausada_at = NULL,
        creditos_restantes = CASE WHEN creditos_restantes IS NULL THEN NULL ELSE 0 END,
        updated_at = v_now
    WHERE id = v_mem.id;
    UPDATE usuarios
    SET status = 'cancelado', membresia_activa_id = NULL, membresia_tier = NULL
    WHERE id = p_usuario_id;
  ELSE
    UPDATE membresias SET cancel_at_period_end = true, updated_at = v_now WHERE id = v_mem.id;
    -- PKG-02H: programar la cancelación en Stripe es una OPERACIÓN durable (misma
    -- transacción que la baja), una por membresía; el ejecutor la aplica después.
    IF v_mem.stripe_subscription_id IS NOT NULL THEN
      INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key)
      VALUES (v_tenant, p_usuario_id, v_mem.id, v_mem.stripe_subscription_id, 'cancelar_fin_periodo', 'baja_fin_periodo',
              'cancelar_fin:' || v_mem.id)
      ON CONFLICT (operation_key) DO NOTHING;
    END IF;
  END IF;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'membresia_baja', 'usuario', p_usuario_id,
          jsonb_build_object('membresia_status', v_mem.status, 'usuario_status', v_usuario.status,
                             'creditos_restantes', v_mem.creditos_restantes),
          jsonb_build_object('membresia_status', CASE WHEN COALESCE(p_inmediata, false) THEN 'cancelada' ELSE v_mem.status END,
                             'cancel_at_period_end', NOT COALESCE(p_inmediata, false)),
          trim(p_motivo),
          jsonb_build_object('membresia_id', v_mem.id, 'inmediata', COALESCE(p_inmediata, false),
                             'stripe_subscription_id', v_mem.stripe_subscription_id));

  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (v_tenant, p_usuario_id, 'membresia_baja', 'Tu membresía se dio de baja',
          CASE WHEN COALESCE(p_inmediata, false)
               THEN 'Dimos de baja tu membresía. Cuando quieras volver, elige un plan desde tu perfil.'
               ELSE 'Tu membresía no se renovará. Conservas tu acceso hasta el fin del periodo que ya pagaste.' END,
          jsonb_build_object('membresia_id', v_mem.id, 'url', '/app/perfil'));

  RETURN jsonb_build_object('success', true, 'membresia_id', v_mem.id,
                            'inmediata', COALESCE(p_inmediata, false),
                            'stripe_subscription_id', v_mem.stripe_subscription_id,
                            'periodo_actual_fin', v_mem.periodo_actual_fin);
END;
$$;
REVOKE ALL ON FUNCTION staff_cancelar_membresia(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_cancelar_membresia(uuid, boolean, text) TO authenticated;

-- EKKO-138, misma definición; la sanción solo descarta SUS suspensiones y no duplica una reanudación en espera (PKG-02H).
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
    SELECT o.id, o.tipo, o.causa INTO v_ultima
    FROM stripe_operaciones_suscripcion o
    WHERE o.membresia_id = v_m.id AND o.tipo IN ('suspender_cobro', 'reanudar_cobro')
      AND (o.estado = 'aplicada'
           OR (o.estado = 'descartada' AND o.motivo_descarte = 'pausa_comercial_vigente'))
    -- PKG-02H: ante empate de tiempos (misma transacción / reloj grueso), manda la
    -- pausa del staff: es la intención independiente que gobierna el cobro.
    ORDER BY COALESCE(o.aplicada_at, o.updated_at) DESC, o.created_at DESC, (o.causa = 'pausa_staff') DESC
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
      -- Sin sanción: una suspensión POR SANCIÓN que no llegó a aplicarse ya no hace
      -- falta. PKG-02H: la pausa del staff (causa pausa_staff) es otra razón y no se toca.
      UPDATE stripe_operaciones_suscripcion
      SET estado = 'descartada', motivo_descarte = 'sancion_levantada'
      WHERE membresia_id = v_m.id AND tipo = 'suspender_cobro' AND causa = 'sancion' AND estado IN ('pendiente', 'fallida');

      -- Y si lo último aplicado fue una suspensión, se reanuda (una vez por suspensión)…
      -- PKG-02H: salvo que ya haya una reanudación en espera (p. ej. la de la
      -- reactivación del staff): no se duplica.
      IF v_ultima.tipo = 'suspender_cobro'
         AND NOT EXISTS (SELECT 1 FROM stripe_operaciones_suscripcion
                         WHERE membresia_id = v_m.id AND tipo = 'reanudar_cobro' AND estado IN ('pendiente', 'fallida')) THEN
        IF v_m.pausa_comercial_at IS NOT NULL THEN
          -- EKKO-138 (D-03A-1 = A): …salvo que el staff haya pausado la membresía:
          -- esa pausa es independiente y sigue vigente. Se deja escrito por qué no
          -- se reanudó; el cobro vuelve solo con la reactivación explícita.
          -- PKG-02H: el marcador cierra el ciclo de una suspensión POR SANCIÓN; si lo
          -- último aplicado es la propia pausa del staff, su operación ya es la evidencia.
          IF v_ultima.causa = 'sancion' THEN
            INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa,
                                                        operation_key, estado, motivo_descarte)
            VALUES (v_m.tenant_id, p_usuario_id, v_m.id, v_m.stripe_subscription_id, 'reanudar_cobro', 'levantar_sancion',
                    'reanudar:' || v_ultima.id, 'descartada', 'pausa_comercial_vigente')
            ON CONFLICT (operation_key) DO NOTHING;
          END IF;
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

-- EKKO-138, misma definición más la revalidación por causa y el tipo nuevo (PKG-02H).
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

  IF v_o.tipo = 'suspender_cobro' AND v_o.causa = 'pausa_staff' THEN
    -- PKG-02H: pausa del staff. Solo procede si la intención sigue vigente.
    v_motivo := CASE
      WHEN v_u.id IS NULL OR v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_u.status = 'revocado' THEN 'cuenta_revocada'
      WHEN v_m.pausa_comercial_at IS NULL THEN 'reactivada'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
    END;
  ELSIF v_o.tipo = 'suspender_cobro' THEN
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
  ELSIF v_o.tipo = 'cancelar_fin_periodo' THEN
    -- PKG-02H: baja al fin del periodo. Si la membresía ya terminó (baja inmediata
    -- posterior, cancelación desde Stripe, expiración) ya no hay qué programar.
    v_motivo := CASE
      WHEN v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN NOT COALESCE(v_m.cancel_at_period_end, false) THEN 'cancelacion_revertida'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
      WHEN EXISTS (SELECT 1 FROM membresias x
                   WHERE x.stripe_subscription_id = v_o.stripe_subscription_id
                     AND x.id IS DISTINCT FROM v_o.membresia_id
                     AND x.status IN ('trialing', 'activa', 'past_due', 'pausada'))
        THEN 'suscripcion_en_uso_por_otra_membresia'
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

-- PKG-03A, misma definición; solo cambia el texto del aviso al primer fallo (PKG-02H).
CREATE OR REPLACE FUNCTION operacion_suscripcion_resultado(p_id uuid, p_ok boolean, p_error text, p_resultado jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o stripe_operaciones_suscripcion;
  v_estado_previo text;
BEGIN
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE id = p_id FOR UPDATE;
  IF v_o.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_NO_EXISTE: Operación no encontrada';
  END IF;
  IF v_o.estado = 'aplicada' THEN
    RETURN jsonb_build_object('success', true, 'estado', 'aplicada', 'idempotente', true);
  END IF;
  v_estado_previo := v_o.estado;

  IF p_ok THEN
    -- Aunque EKKO la hubiera descartado mientras estaba en vuelo: el proveedor la
    -- aplicó y eso es lo que queda asentado.
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'aplicada', aplicada_at = now(), ultimo_error = NULL,
        resultado = COALESCE(p_resultado, '{}'::jsonb), reintentos_agotados_at = NULL
    WHERE id = v_o.id;
    -- Encadena lo que falte (p. ej. se levantó la sanción mientras se suspendía).
    IF v_o.tipo IN ('suspender_cobro', 'reanudar_cobro') AND v_o.usuario_id IS NOT NULL THEN
      PERFORM _reconciliar_cobro_sancion(v_o.usuario_id);
    END IF;
    RETURN jsonb_build_object('success', true, 'estado', 'aplicada', 'idempotente', false);
  END IF;

  IF v_o.estado = 'descartada' THEN
    RETURN jsonb_build_object('success', true, 'estado', 'descartada');
  END IF;

  UPDATE stripe_operaciones_suscripcion
  SET estado = 'fallida', ultimo_error = left(COALESCE(p_error, 'error_desconocido'), 300),
      resultado = COALESCE(p_resultado, resultado),
      -- PKG-03A: tope de 5 intentos automáticos por ronda.
      reintentos_agotados_at = CASE WHEN intentos - intentos_ronda_base >= 5 THEN now() ELSE NULL END
  WHERE id = v_o.id
  RETURNING * INTO v_o;

  IF v_o.reintentos_agotados_at IS NOT NULL THEN
    PERFORM _avisar_admins(
      v_o.tenant_id, 'stripe_revision',
      'Un cambio de cobro necesita tu decisión',
      'Stripe no aplicó un cambio de cobro tras varios intentos y ya no se reintentará solo. Revísalo en Operación: reintentar o descartar con nota.',
      jsonb_build_object('operacion_id', v_o.id, 'tipo', v_o.tipo, 'causa', v_o.causa,
                         'usuario_id', v_o.usuario_id, 'url', '/admin/operacion'));
  ELSIF v_estado_previo = 'pendiente' THEN
    PERFORM _avisar_admins(
      v_o.tenant_id, 'stripe_revision',
      'Stripe no aplicó un cambio de cobro',
      CASE
        WHEN v_o.causa = 'pausa_staff' THEN 'No se pudo PAUSAR el cobro en Stripe de una membresía que el staff puso en pausa. La pausa en EKKO sigue vigente; se reintentará.'
        WHEN v_o.causa = 'reactivacion_staff' THEN 'No se pudo REANUDAR el cobro en Stripe de una membresía reactivada por el staff. Se reintentará.'
        WHEN v_o.tipo = 'cancelar_fin_periodo' THEN 'No se pudo programar en Stripe la cancelación al fin del periodo de una baja. La baja en EKKO sigue vigente; se reintentará.'
        WHEN v_o.tipo = 'suspender_cobro' THEN 'No se pudo SUSPENDER el cobro de un miembro sancionado. La sanción sigue vigente; el cobro se reintentará.'
        WHEN v_o.tipo = 'reanudar_cobro' THEN 'No se pudo REANUDAR el cobro de un miembro al que se le levantó la sanción. Se reintentará.'
        ELSE 'No se pudo CANCELAR en Stripe la suscripción de una cuenta dada de baja o revocada. El acceso sigue bloqueado; se reintentará.'
      END,
      jsonb_build_object('operacion_id', v_o.id, 'tipo', v_o.tipo, 'causa', v_o.causa,
                         'usuario_id', v_o.usuario_id, 'url', '/admin/miembros/' || COALESCE(v_o.usuario_id::text, '')));
  END IF;
  RETURN jsonb_build_object('success', true, 'estado', 'fallida', 'agotada', v_o.reintentos_agotados_at IS NOT NULL);
END;
$$;
REVOKE ALL ON FUNCTION operacion_suscripcion_resultado(uuid, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION operacion_suscripcion_resultado(uuid, boolean, text, jsonb) TO service_role;
