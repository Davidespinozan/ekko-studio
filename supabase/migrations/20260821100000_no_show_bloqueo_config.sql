-- ============================================================================
-- No-show: el bloqueo obedece a la config del tenant (perilla que estaba muerta)
-- ============================================================================
-- Admin → Reglas → Penalizaciones guarda `config.penalizaciones.no_show_bloqueo_dias`
-- desde el día 1, pero la versión vigente de `marcar_no_shows()` (20260704170000)
-- hardcodeaba "3 faltas / 7 días" y NO leía tenants.config. La versión de
-- 20260517000001 sí lo leía; se perdió al recrear la función.
--
-- Reglas (idénticas a netlify/functions/_lib/noShow.ts, que usa recepción):
--   · no_show_bloqueo_dias (default 7): 0 = solo registrar la falta, sin bloquear.
--   · no_show_umbral       (default 3, mínimo 1): a partir de qué falta se bloquea.
--   · count siempre +1; bloqueo = GREATEST(bloqueo vigente, now + días).
-- Además el miembro recibe un aviso in-app (`notificaciones`, tipo 'no_show'):
-- antes se enteraba del bloqueo al intentar reservar.
-- Idempotente. Conserva la ventana +60 min y la auditoría de 20260704170000.
-- ============================================================================

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
  v_pen jsonb;
  v_umbral integer;
  v_bloqueo_dias integer;
  v_antes_count integer;
  v_antes_bloqueo timestamptz;
  v_despues_count integer;
  v_despues_bloqueo timestamptz;
  v_bloquea boolean;
  v_titulo text;
  v_mensaje text;
  v_restantes integer;
  r record;
BEGIN
  FOR r IN
    SELECT res.id, res.usuario_id, res.tenant_id, res.folio, t.config AS tenant_config
    FROM reservas res
    JOIN tenants t ON t.id = res.tenant_id
    WHERE res.status = 'confirmada'
      AND res.check_in_at IS NULL
      -- +60 min: alineado con la ventana del check-in manual.
      AND res.slot_fin + interval '60 minutes' < v_now
  LOOP
    -- Config del tenant, tolerante a basura (solo enteros no negativos).
    v_pen := COALESCE(r.tenant_config->'penalizaciones', '{}'::jsonb);
    v_bloqueo_dias := COALESCE(
      CASE WHEN (v_pen->>'no_show_bloqueo_dias') ~ '^\d+$' THEN (v_pen->>'no_show_bloqueo_dias')::integer END,
      7
    );
    v_umbral := GREATEST(1, COALESCE(
      CASE WHEN (v_pen->>'no_show_umbral') ~ '^\d+$' THEN (v_pen->>'no_show_umbral')::integer END,
      3
    ));

    UPDATE reservas SET status = 'no_show' WHERE id = r.id;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    SELECT no_shows_count, bloqueado_hasta
      INTO v_antes_count, v_antes_bloqueo
      FROM usuarios WHERE id = r.usuario_id;

    v_bloquea := v_bloqueo_dias > 0 AND (COALESCE(v_antes_count, 0) + 1) >= v_umbral;

    UPDATE usuarios
    SET no_shows_count = no_shows_count + 1,
        bloqueado_hasta = CASE
          WHEN v_bloquea
          THEN GREATEST(COALESCE(bloqueado_hasta, v_now), v_now) + (v_bloqueo_dias || ' days')::interval
          ELSE bloqueado_hasta
        END
    WHERE id = r.usuario_id
    RETURNING no_shows_count, bloqueado_hasta INTO v_despues_count, v_despues_bloqueo;

    IF v_bloquea THEN
      v_usuarios_bloqueados := v_usuarios_bloqueados + 1;
    END IF;

    -- Aviso al miembro (mismo texto que _lib/noShow.ts).
    IF v_bloquea THEN
      v_titulo := 'Cuenta bloqueada por inasistencia';
      v_mensaje := format(
        'No llegaste a tu sesión reservada (%s). Llevas %s de %s faltas permitidas. Tu cuenta queda bloqueada para reservar hasta el %s.',
        COALESCE(r.folio, 'sin folio'), v_despues_count, v_umbral,
        to_char(v_despues_bloqueo AT TIME ZONE 'America/Mazatlan', 'DD/MM')
      );
    ELSE
      v_restantes := GREATEST(0, v_umbral - v_despues_count);
      v_titulo := 'Registramos una inasistencia';
      v_mensaje := format(
        'No llegaste a tu sesión reservada (%s). Llevas %s de %s faltas permitidas.%s',
        COALESCE(r.folio, 'sin folio'), v_despues_count, v_umbral,
        CASE
          WHEN v_bloqueo_dias > 0 AND v_restantes > 0 THEN
            format(' Si faltas %s, tu cuenta se bloquea %s días.',
              CASE WHEN v_restantes = 1 THEN 'una vez más' ELSE v_restantes || ' veces más' END,
              v_bloqueo_dias)
          ELSE ''
        END
      );
    END IF;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      r.tenant_id, r.usuario_id, 'no_show', v_titulo, v_mensaje,
      jsonb_build_object('reserva_id', r.id, 'folio', r.folio, 'bloqueado_hasta', v_despues_bloqueo)
    );

    INSERT INTO audit_log (
      tenant_id, actor_usuario_id, actor_rol, accion,
      target_tipo, target_id, antes, despues, metadata
    ) VALUES (
      r.tenant_id, NULL, 'service_role', 'no_show_cron',
      'usuario', r.usuario_id,
      jsonb_build_object('reserva_status', 'confirmada', 'no_shows_count', v_antes_count, 'bloqueado_hasta', v_antes_bloqueo),
      jsonb_build_object('reserva_status', 'no_show', 'no_shows_count', v_despues_count, 'bloqueado_hasta', v_despues_bloqueo),
      jsonb_build_object('reserva_id', r.id, 'folio', r.folio, 'umbral', v_umbral, 'bloqueo_dias', v_bloqueo_dias)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'timestamp', v_now
  );
END;
$$;

COMMENT ON FUNCTION marcar_no_shows() IS
  'Cron horario: confirmadas sin check-in pasados +60 min → no_show; cuenta la falta, bloquea según config.penalizaciones (no_show_bloqueo_dias, 0 = no bloquear; no_show_umbral) y avisa al miembro.';

-- CREATE OR REPLACE conserva los privilegios, pero se reafirman (H5 de SECURITY_AUDIT).
REVOKE EXECUTE ON FUNCTION marcar_no_shows() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION marcar_no_shows() TO service_role;

-- ── Self-test de contrato: si alguien recrea la función sin leer la config, falla ──
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'marcar_no_shows' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL OR position('no_show_bloqueo_dias' in v_src) = 0 OR position('no_show_umbral' in v_src) = 0 THEN
    RAISE EXCEPTION 'marcar_no_shows() debe leer config.penalizaciones (no_show_bloqueo_dias / no_show_umbral)';
  END IF;
  IF has_function_privilege('authenticated', 'marcar_no_shows()', 'EXECUTE') THEN
    RAISE EXCEPTION 'marcar_no_shows() no debe ser ejecutable por authenticated';
  END IF;
END $$;
