-- ============================================================================
-- Admin: 'en venta' separado de 'activo' + avisos de vencimiento + cumpleaños
-- ============================================================================
-- 1) tiers.en_venta — "dejar de vender" un plan sin archivarlo. Hoy archivar está
--    bloqueado si hay miembros con el plan (Tiers.tsx), así que NO había forma de
--    retirar un plan de la venta y dejar que los actuales lo terminen. en_venta
--    controla landing/signup/pago; el acceso (activo) no se toca. (SALA 6257844.)
-- 2) avisar_membresias_por_vencer(p_dias) — nadie avisaba al miembro. En EKKO
--    las mensuales de Stripe se renuevan solas, así que solo se avisa cuando SÍ
--    hay que actuar: paquetes con caducidad (hibrido), membresías manuales
--    (mostrador) y mensuales con cancel_at_period_end. Una vez por periodo
--    (membresias.aviso_vencimiento_at). Devuelve las filas para que el cron
--    mande el push. (SALA 20260714120000.)
-- 3) generar_felicitaciones_cumpleanos() — usa usuarios_datos_privados.
--    fecha_nacimiento (obligatoria por la ficha de identidad). Idempotente por
--    día en America/Mazatlan. Devuelve filas para push. (SALA b0ba8e4.)
-- Idempotente.
-- ============================================================================

-- ── 1. en_venta ──────────────────────────────────────────────────────────────
ALTER TABLE tiers ADD COLUMN IF NOT EXISTS en_venta boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN tiers.en_venta IS
  'true = se ofrece en landing/signup/pago a miembros nuevos. false = retirado de la venta, pero los miembros que ya lo tienen siguen con acceso (a diferencia de activo=false). Para "ya no se vende", apagar esto, no archivar.';

-- ── 2. Avisos de vencimiento ─────────────────────────────────────────────────
ALTER TABLE membresias ADD COLUMN IF NOT EXISTS aviso_vencimiento_at timestamptz;
COMMENT ON COLUMN membresias.aviso_vencimiento_at IS
  'Cuándo se avisó al miembro que su plan/paquete estaba por vencer (una vez por periodo).';

CREATE OR REPLACE FUNCTION avisar_membresias_por_vencer(p_dias integer DEFAULT 3)
RETURNS TABLE (usuario_id uuid, tenant_id uuid, titulo text, mensaje text, membresia_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_titulo text;
  v_mensaje text;
  v_fecha text;
BEGIN
  FOR r IN
    SELECT m.id, m.usuario_id, m.tenant_id, m.periodo_actual_fin, m.periodo_actual_inicio,
           m.stripe_subscription_id, m.cancel_at_period_end, m.creditos_restantes,
           t.nombre AS tier_nombre, t.tipo AS tier_tipo
    FROM membresias m
    JOIN tiers t ON t.id = m.tier_id
    WHERE m.status IN ('activa', 'trialing')
      AND m.periodo_actual_fin IS NOT NULL
      AND m.periodo_actual_fin > now()
      AND m.periodo_actual_fin <= now() + (p_dias || ' days')::interval
      -- Solo cuando el miembro tiene que hacer algo: las mensuales de Stripe
      -- vigentes se renuevan solas.
      AND (m.stripe_subscription_id IS NULL OR m.cancel_at_period_end = true)
      -- Todavía no se avisó de ESTE periodo.
      AND (m.aviso_vencimiento_at IS NULL
           OR m.periodo_actual_inicio IS NULL
           OR m.aviso_vencimiento_at < m.periodo_actual_inicio)
  LOOP
    v_fecha := to_char(r.periodo_actual_fin AT TIME ZONE 'America/Mazatlan', 'DD/MM');
    IF r.tier_tipo IN ('creditos', 'hibrido') THEN
      v_titulo := 'Tus créditos están por caducar';
      v_mensaje := 'Tu paquete ' || r.tier_nombre || ' caduca el ' || v_fecha ||
                   CASE WHEN COALESCE(r.creditos_restantes, 0) > 0
                        THEN ' y te quedan ' || r.creditos_restantes || ' crédito(s). Úsalos o compra otro paquete.'
                        ELSE '.' END;
    ELSIF r.cancel_at_period_end THEN
      v_titulo := 'Tu plan termina pronto';
      v_mensaje := 'Tu ' || r.tier_nombre || ' termina el ' || v_fecha || ' (cancelaste la renovación). Si cambias de opinión, reactívalo desde tu perfil.';
    ELSE
      v_titulo := 'Tu plan está por vencer';
      v_mensaje := 'Tu ' || r.tier_nombre || ' vence el ' || v_fecha || '. Renuévalo en la app o en recepción para seguir reservando.';
    END IF;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (r.tenant_id, r.usuario_id, 'membresia_por_vencer', v_titulo, v_mensaje,
            jsonb_build_object('membresia_id', r.id, 'vence', r.periodo_actual_fin));

    UPDATE membresias SET aviso_vencimiento_at = now() WHERE id = r.id;

    usuario_id := r.usuario_id; tenant_id := r.tenant_id; titulo := v_titulo; mensaje := v_mensaje; membresia_id := r.id;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION avisar_membresias_por_vencer(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION avisar_membresias_por_vencer(integer) TO service_role;

-- ── 3. Cumpleaños ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION generar_felicitaciones_cumpleanos()
RETURNS TABLE (usuario_id uuid, tenant_id uuid, titulo text, mensaje text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_hoy date := (now() AT TIME ZONE 'America/Mazatlan')::date;
  v_nombre1 text;
  v_mensaje text;
BEGIN
  FOR r IN
    SELECT dp.usuario_id, dp.tenant_id, dp.fecha_nacimiento, u.nombre
    FROM usuarios_datos_privados dp
    JOIN usuarios u ON u.id = dp.usuario_id
    WHERE dp.fecha_nacimiento IS NOT NULL
      AND u.rol = 'miembro'
      AND u.status = 'activo'
      AND EXTRACT(MONTH FROM dp.fecha_nacimiento) = EXTRACT(MONTH FROM v_hoy)
      AND EXTRACT(DAY FROM dp.fecha_nacimiento) = EXTRACT(DAY FROM v_hoy)
      -- Idempotente: una felicitación por día.
      AND NOT EXISTS (
        SELECT 1 FROM notificaciones n
        WHERE n.usuario_id = dp.usuario_id
          AND n.tipo = 'cumpleanos'
          AND (n.creada_at AT TIME ZONE 'America/Mazatlan')::date = v_hoy
      )
  LOOP
    v_nombre1 := NULLIF(split_part(COALESCE(r.nombre, ''), ' ', 1), '');
    v_mensaje := CASE WHEN v_nombre1 IS NOT NULL
      THEN '¡Feliz cumpleaños, ' || v_nombre1 || '! Que sea un gran día para crear. 🎉'
      ELSE '¡Feliz cumpleaños! Que sea un gran día para crear. 🎉' END;
    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje)
    VALUES (r.tenant_id, r.usuario_id, 'cumpleanos', '¡Feliz cumpleaños! 🎂', v_mensaje);
    usuario_id := r.usuario_id; tenant_id := r.tenant_id; titulo := '¡Feliz cumpleaños! 🎂'; mensaje := v_mensaje;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION generar_felicitaciones_cumpleanos() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION generar_felicitaciones_cumpleanos() TO service_role;

-- Cumpleañeros de HOY y próximos días para la tarjeta de recepción/admin
-- (usuarios_datos_privados es admin-only por RLS; recepción la necesita solo
-- para esta vista: nombre + día, sin exponer la fecha completa ni el domicilio).
CREATE OR REPLACE FUNCTION cumpleanos_proximos(p_dias integer DEFAULT 7)
RETURNS TABLE (usuario_id uuid, nombre text, avatar_url text, dia date, en_dias integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT u.id, u.nombre, u.avatar_url, dp.fecha_nacimiento,
           (now() AT TIME ZONE 'America/Mazatlan')::date AS hoy
    FROM usuarios_datos_privados dp
    JOIN usuarios u ON u.id = dp.usuario_id
    WHERE dp.tenant_id = get_my_tenant_id()
      AND get_my_rol() IN ('admin', 'recepcionista')
      AND dp.fecha_nacimiento IS NOT NULL
      AND u.rol = 'miembro'
      AND u.status = 'activo'
  ), calc AS (
    SELECT id, nombre, avatar_url, hoy,
      -- Próximo cumpleaños: este año, o el que viene si ya pasó.
      CASE WHEN make_date(EXTRACT(YEAR FROM hoy)::int, EXTRACT(MONTH FROM fecha_nacimiento)::int, LEAST(EXTRACT(DAY FROM fecha_nacimiento)::int, 28 + CASE WHEN EXTRACT(MONTH FROM fecha_nacimiento) = 2 THEN 0 ELSE 3 END)) >= hoy
           THEN make_date(EXTRACT(YEAR FROM hoy)::int, EXTRACT(MONTH FROM fecha_nacimiento)::int, LEAST(EXTRACT(DAY FROM fecha_nacimiento)::int, 28 + CASE WHEN EXTRACT(MONTH FROM fecha_nacimiento) = 2 THEN 0 ELSE 3 END))
           ELSE make_date(EXTRACT(YEAR FROM hoy)::int + 1, EXTRACT(MONTH FROM fecha_nacimiento)::int, LEAST(EXTRACT(DAY FROM fecha_nacimiento)::int, 28 + CASE WHEN EXTRACT(MONTH FROM fecha_nacimiento) = 2 THEN 0 ELSE 3 END))
      END AS proximo
    FROM base
  )
  SELECT id, nombre, avatar_url, proximo, (proximo - hoy)::int
  FROM calc
  WHERE proximo - hoy <= GREATEST(0, p_dias)
  ORDER BY proximo, nombre;
$$;

REVOKE ALL ON FUNCTION cumpleanos_proximos(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cumpleanos_proximos(integer) TO authenticated, service_role;

-- ── Self-test ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tiers' AND column_name = 'en_venta') THEN
    RAISE EXCEPTION 'falta tiers.en_venta';
  END IF;
  IF has_function_privilege('authenticated', 'avisar_membresias_por_vencer(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'generar_felicitaciones_cumpleanos()', 'EXECUTE') THEN
    RAISE EXCEPTION 'los RPC de cron no deben ser ejecutables por authenticated';
  END IF;
  IF position('get_my_tenant_id' in (SELECT prosrc FROM pg_proc WHERE proname = 'cumpleanos_proximos')) = 0 THEN
    RAISE EXCEPTION 'cumpleanos_proximos debe acotar al tenant del caller';
  END IF;
END $$;
