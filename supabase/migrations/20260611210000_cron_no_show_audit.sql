-- ============================================================================
-- Bloque E — cierre de deuda (Bloque D): el cron escribe audit_log
-- ============================================================================
-- `marcar_no_shows` es anterior a Bloque A y no dejaba traza. Ahora inserta una
-- entrada de audit_log POR CADA miembro afectado (no una por corrida), con
-- actor_rol='service_role' y accion='no_show_cron'. Mismo patrón que el no-show
-- manual de Bloque D (target_tipo='usuario', metadata con reserva/folio).
--
-- El INSERT corre dentro de la función SECURITY DEFINER (owner postgres), que
-- tiene privilegio sobre audit_log — no necesita el helper JS writeAuditLog.
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
      AND slot_fin + interval '30 minutes' < v_now
  LOOP
    UPDATE reservas SET status = 'no_show' WHERE id = r.id;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    -- Estado previo del miembro (para el delta del audit).
    SELECT no_shows_count, bloqueado_hasta
      INTO v_antes_count, v_antes_bloqueo
      FROM usuarios WHERE id = r.usuario_id;

    UPDATE usuarios
    SET no_shows_count = no_shows_count + 1,
        bloqueado_hasta = GREATEST(
          COALESCE(bloqueado_hasta, v_now),
          v_now + interval '7 days'
        )
    WHERE id = r.usuario_id
    RETURNING no_shows_count, bloqueado_hasta INTO v_despues_count, v_despues_bloqueo;
    v_usuarios_bloqueados := v_usuarios_bloqueados + 1;

    -- Audit: una entrada por miembro afectado (cierra deuda de Bloque D).
    INSERT INTO audit_log (
      tenant_id, actor_usuario_id, actor_rol, accion,
      target_tipo, target_id, antes, despues, metadata
    ) VALUES (
      r.tenant_id, NULL, 'service_role', 'no_show_cron',
      'usuario', r.usuario_id,
      jsonb_build_object(
        'reserva_status', 'confirmada',
        'no_shows_count', v_antes_count,
        'bloqueado_hasta', v_antes_bloqueo
      ),
      jsonb_build_object(
        'reserva_status', 'no_show',
        'no_shows_count', v_despues_count,
        'bloqueado_hasta', v_despues_bloqueo
      ),
      jsonb_build_object('reserva_id', r.id, 'folio', r.folio)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'timestamp', v_now
  );
END;
$$;

-- Mantener la restricción de SEC-FIX H5 (solo service_role la ejecuta).
REVOKE EXECUTE ON FUNCTION marcar_no_shows() FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION marcar_no_shows() TO service_role;
