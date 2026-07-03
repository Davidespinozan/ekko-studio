-- ============================================================================
-- Fixes del chequeo ultraprofundo — capa de BD (críticos + altos)
-- ----------------------------------------------------------------------------
-- 1 (CRÍTICO) — Paquete vencido dejaba reservar GRATIS: el cron marcaba la
--   membresía 'expirada' pero no le quitaba el plan al usuario, así que pasaba
--   el gate y el trigger de créditos no cobraba. Ahora expirar_membresias_vencidas
--   NULEA membresia_tier/membresia_activa_id y asienta la pérdida en el ledger.
-- 5 (CRÍTICO) — activar_membresia no era idempotente por suscripción → doble
--   acreditación. Ahora si ya existe una membresía viva con esa sub, es no-op.
-- 9 (ALTO) — la acumulación revivía créditos de paquetes ya vencidos por fecha.
--   Ahora el saldo previo excluye periodos vencidos.
-- 10 (ALTO) — cerrar/expirar una membresía dejaba creditos_restantes "vivos" sin
--   asiento → el ledger no cuadraba. Ahora se zera y se journaliza.
-- 7 (ALTO) — los paquetes de créditos no tenían reglas.max_invitados → el RPC
--   caía en ELSE 0 y bloqueaba a 0 invitados. Se siembra max_invitados=2.
-- No-show — bloqueo desde la 1ª falta → ahora a partir de la 3ª (decisión del
--   dueño), y se alinea la ventana del cron (+30→+60) con el check-in manual.
--
-- Todo idempotente (CREATE OR REPLACE + seeds condicionales).
-- ============================================================================


-- ── activar_membresia: idempotencia (#5), no revivir vencidos (#9), zerar+journal la previa (#10)
CREATE OR REPLACE FUNCTION activar_membresia(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_periodo_fin timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usuario usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_fin timestamptz;
  v_membresia_id uuid;
  v_es_paquete boolean;
  v_saldo_previo integer := 0;
  v_creditos integer;
  v_existente uuid;
BEGIN
  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_USUARIO_NO_EXISTE: Miembro no encontrado';
  END IF;

  SELECT * INTO v_tier
  FROM tiers
  WHERE id = p_tier_id AND tenant_id = v_usuario.tenant_id AND activo = true;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_TIER_INVALIDO: Plan no encontrado o inactivo';
  END IF;

  -- #5 Idempotencia por suscripción: si ya hay una membresía viva con esta sub,
  -- el evento es duplicado (reintento de Stripe / dos eventos del mismo pago) → no-op.
  IF p_stripe_subscription_id IS NOT NULL THEN
    SELECT id INTO v_existente
    FROM membresias
    WHERE usuario_id = p_usuario_id
      AND stripe_subscription_id = p_stripe_subscription_id
      AND status IN ('trialing', 'activa', 'past_due')
    LIMIT 1;
    IF v_existente IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'membresia_id', v_existente, 'idempotente', true);
    END IF;
  END IF;

  v_es_paquete := v_tier.tipo IN ('creditos', 'hibrido');

  -- #9 Saldo previo para ACUMULAR: NO revivir créditos de paquetes ya vencidos
  -- por fecha (aunque el cron aún no los haya barrido).
  IF v_es_paquete THEN
    SELECT COALESCE(SUM(creditos_restantes), 0) INTO v_saldo_previo
    FROM membresias
    WHERE usuario_id = p_usuario_id
      AND status IN ('trialing', 'activa', 'past_due')
      AND creditos_restantes IS NOT NULL
      AND (periodo_actual_fin IS NULL OR periodo_actual_fin > v_now);
  END IF;

  -- Vigencia según tipo.
  IF v_tier.tipo = 'creditos' THEN
    v_fin := NULL;
  ELSIF v_tier.tipo = 'hibrido' THEN
    v_fin := v_now + (COALESCE(v_tier.duracion_dias, 30) || ' days')::interval;
  ELSE  -- tiempo
    v_fin := COALESCE(
      p_periodo_fin,
      CASE WHEN v_tier.duracion_dias IS NOT NULL
           THEN v_now + (v_tier.duracion_dias || ' days')::interval
           ELSE v_now + interval '1 month' END
    );
  END IF;

  IF v_es_paquete THEN
    v_creditos := v_saldo_previo + COALESCE(v_tier.clases_incluidas, 0);
  ELSE
    v_creditos := NULL;
  END IF;

  -- #10 Asentar en el ledger los créditos que se pierden al cerrar la membresía
  -- previa (antes quedaban "vivos" fantasma), y luego zerarlos.
  INSERT INTO membresia_movimientos (
    tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo
  )
  SELECT tenant_id, id, usuario_id, 'ajuste', -creditos_restantes, 0, 'Cierre de membresía anterior'
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('trialing', 'activa', 'past_due')
    AND COALESCE(creditos_restantes, 0) > 0;

  UPDATE membresias
  SET status = 'cancelada',
      cancelada_at = v_now,
      cancelada_efectiva_at = v_now,
      creditos_restantes = CASE WHEN creditos_restantes IS NULL THEN NULL ELSE 0 END,
      updated_at = v_now
  WHERE usuario_id = p_usuario_id
    AND status IN ('trialing', 'activa', 'past_due');

  -- Crear la membresía activa.
  INSERT INTO membresias (
    tenant_id, usuario_id, tier_id, status,
    periodo_actual_inicio, periodo_actual_fin, creditos_restantes,
    stripe_subscription_id, stripe_customer_id
  ) VALUES (
    v_usuario.tenant_id, p_usuario_id, p_tier_id, 'activa',
    v_now, v_fin, v_creditos,
    p_stripe_subscription_id, p_stripe_customer_id
  )
  RETURNING id INTO v_membresia_id;

  -- Ledger: alta FRESCA (delta = clases del plan; el arrastre va como asiento aparte).
  INSERT INTO membresia_movimientos (
    tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo
  ) VALUES (
    v_usuario.tenant_id, v_membresia_id, p_usuario_id, 'alta',
    COALESCE(v_tier.clases_incluidas, 0),
    CASE WHEN v_es_paquete THEN COALESCE(v_tier.clases_incluidas, 0) ELSE NULL END,
    'Alta de ' || v_tier.slug
  );

  -- #10 Créditos arrastrados del plan anterior, como movimiento propio para que
  -- el ledger de la nueva membresía reconcilie con su saldo.
  IF v_es_paquete AND v_saldo_previo > 0 THEN
    INSERT INTO membresia_movimientos (
      tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo
    ) VALUES (
      v_usuario.tenant_id, v_membresia_id, p_usuario_id, 'ajuste',
      v_saldo_previo, v_creditos, 'Créditos trasladados del plan anterior'
    );
  END IF;

  UPDATE usuarios
  SET status = 'activo',
      membresia_tier = v_tier.slug,
      membresia_activa_id = v_membresia_id
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
    'success', true,
    'membresia_id', v_membresia_id,
    'tier', v_tier.slug,
    'periodo_fin', v_fin,
    'creditos', v_creditos
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION activar_membresia(uuid, uuid, text, text, timestamptz)
  FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION activar_membresia(uuid, uuid, text, text, timestamptz)
  TO service_role;


-- ── #1 expirar_membresias_vencidas: quitar el plan al usuario + journalizar ──
CREATE OR REPLACE FUNCTION expirar_membresias_vencidas()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- 1. Asentar en el ledger los créditos que se pierden al expirar (antes de zerar).
  INSERT INTO membresia_movimientos (
    tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo
  )
  SELECT tenant_id, id, usuario_id, 'ajuste', -creditos_restantes, 0, 'Créditos expirados'
  FROM membresias
  WHERE status IN ('activa', 'trialing', 'past_due')
    AND stripe_subscription_id IS NULL
    AND periodo_actual_fin IS NOT NULL
    AND periodo_actual_fin < now()
    AND COALESCE(creditos_restantes, 0) > 0;

  -- 2. Expirar + zerar el saldo, y quitarle el plan al usuario cuya membresía
  --    ACTIVA venció (si no, seguía 'activo' con tier → reservaba GRATIS).
  WITH vencidas AS (
    UPDATE membresias
    SET status = 'expirada',
        creditos_restantes = CASE WHEN creditos_restantes IS NULL THEN NULL ELSE 0 END,
        updated_at = now()
    WHERE status IN ('activa', 'trialing', 'past_due')
      AND stripe_subscription_id IS NULL
      AND periodo_actual_fin IS NOT NULL
      AND periodo_actual_fin < now()
    RETURNING id, usuario_id
  ),
  limpieza AS (
    UPDATE usuarios u
    SET membresia_tier = NULL, membresia_activa_id = NULL
    FROM vencidas v
    WHERE u.id = v.usuario_id AND u.membresia_activa_id = v.id
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM vencidas;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION expirar_membresias_vencidas() IS
  'Expira paquetes (no-Stripe) vencidos por fecha: marca expirada, zera y journaliza créditos, y quita el plan al usuario para cerrar el hueco de reservas gratis.';


-- ── No-show: bloquear a partir de la 3ª falta + alinear ventana (+60) ────────
CREATE OR REPLACE FUNCTION marcar_no_shows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reservas_afectadas integer := 0;
  v_usuarios_bloqueados integer := 0;
  v_now timestamptz := now();
  v_umbral constant integer := 3;   -- bloquea a partir de la 3ª inasistencia
  v_antes_count integer;
  v_antes_bloqueo timestamptz;
  v_despues_count integer;
  v_despues_bloqueo timestamptz;
  r record;
BEGIN
  FOR r IN
    SELECT id, usuario_id, tenant_id, folio
    FROM reservas
    WHERE status = 'confirmada'
      AND check_in_at IS NULL
      -- +60 min: alineado con la ventana del check-in manual (antes +30, que
      -- marcaba no_show a quien recepción todavía podía dar ingreso).
      AND slot_fin + interval '60 minutes' < v_now
  LOOP
    UPDATE reservas SET status = 'no_show' WHERE id = r.id;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    SELECT no_shows_count, bloqueado_hasta
      INTO v_antes_count, v_antes_bloqueo
      FROM usuarios WHERE id = r.usuario_id;

    -- Cuenta siempre; bloquea 7 días SOLO al alcanzar el umbral.
    UPDATE usuarios
    SET no_shows_count = no_shows_count + 1,
        bloqueado_hasta = CASE
          WHEN no_shows_count + 1 >= v_umbral
          THEN GREATEST(COALESCE(bloqueado_hasta, v_now), v_now + interval '7 days')
          ELSE bloqueado_hasta
        END
    WHERE id = r.usuario_id
    RETURNING no_shows_count, bloqueado_hasta INTO v_despues_count, v_despues_bloqueo;

    IF v_despues_count >= v_umbral THEN
      v_usuarios_bloqueados := v_usuarios_bloqueados + 1;
    END IF;

    INSERT INTO audit_log (
      tenant_id, actor_usuario_id, actor_rol, accion,
      target_tipo, target_id, antes, despues, metadata
    ) VALUES (
      r.tenant_id, NULL, 'service_role', 'no_show_cron',
      'usuario', r.usuario_id,
      jsonb_build_object('reserva_status', 'confirmada', 'no_shows_count', v_antes_count, 'bloqueado_hasta', v_antes_bloqueo),
      jsonb_build_object('reserva_status', 'no_show', 'no_shows_count', v_despues_count, 'bloqueado_hasta', v_despues_bloqueo),
      jsonb_build_object('reserva_id', r.id, 'folio', r.folio, 'umbral', v_umbral)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'timestamp', v_now
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION marcar_no_shows() FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION marcar_no_shows() TO service_role;


-- ── #7 Paquetes de créditos: sembrar reglas.max_invitados (antes caían en 0) ──
UPDATE tiers
SET reglas = COALESCE(reglas, '{}'::jsonb) || '{"max_invitados": 2}'::jsonb
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'ekko')
  AND slug IN ('sesion-suelta', 'starter', 'creador', 'pro-pack')
  AND NOT (COALESCE(reglas, '{}'::jsonb) ? 'max_invitados');
