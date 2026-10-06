-- ============================================================================
-- PKG-06E · Ciclo de vida del material (FR-42..46, EKKO-147)
-- ============================================================================
-- La base y Storage no son una transacción. Pueden divergir un rato, pero esa
-- divergencia ahora se DETECTA, se REINTENTA desde el servidor y, si no converge,
-- la VE un humano. Sin tabla nueva: el estado de negocio sigue siendo la fila
-- (`eliminado_at`, `disponible_hasta`) y el estado de limpieza se DERIVA al
-- comparar la fila con los metadatos de Storage (`storage.objects`, la misma
-- base: sin listar por API, sin paginar, sin escaneos parciales):
--
--   negocio (acceso)                 objeto en Storage   → estado de limpieza
--   vivo (eliminado_at NULL)         presente            → correcto
--   vivo                             ausente             → material SIN ARCHIVO (humano)
--   retirado/vencido (eliminado_at)  presente            → limpieza PENDIENTE (cron)
--   retirado/vencido                 ausente             → limpieza COMPLETA
--   (sin fila)                       presente            → objeto HUÉRFANO (humano; nunca se borra solo)
--
--  1. `material_limpieza_pendiente` (solo service_role): objetos que el NEGOCIO ya
--     retiró y siguen en Storage. Las rutas salen de la base, nunca de un cliente.
--     El cron diario los borra; "ya no estaba" converge a completo.
--  2. `staff_eliminar_material` (recreada): idempotente. Retirar dos veces no es un
--     error: devuelve la misma ruta (para reintentar el borrado) sin otra auditoría.
--  3. `staff_listar_material_pendiente` (recreada): pendiente = la sesión OCURRIÓ
--     (check-in → `completada`), requiere material y NUNCA se le registró material.
--     Un material vencido, barrido o retirado ya fue entregado: no vuelve a ser
--     pendiente. Una sesión pasada sin check-in no consta como ocurrida.
--  4. `v_pendientes_operativos`: igual que 06C/06B salvo tres ramas nuevas de
--     material (solo admin, su estudio): material sin archivo (por material),
--     limpieza atascada (> 2 días, agregada) y objetos huérfanos (> 1 h, agregados).
--
-- Aditiva: el código viejo (borrado best-effort desde el navegador y cron sin
-- reintento) sigue funcionando sobre esta base; lo nuevo solo suma reintento y
-- visibilidad.
-- ============================================================================


-- ── 1. Limpieza pendiente (derivada) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION material_limpieza_pendiente(p_limite integer DEFAULT 200)
RETURNS TABLE (material_id uuid, storage_path text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.storage_path
  FROM material_sesion m
  WHERE m.tipo = 'archivo'
    AND m.eliminado_at IS NOT NULL
    AND m.storage_path IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'material' AND o.name = m.storage_path
        -- Storage con versiones deja marcas de borrado: no cuentan como objeto vivo.
        AND COALESCE((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false
    )
  ORDER BY m.eliminado_at, m.id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limite, 200), 500));
$$;
REVOKE ALL ON FUNCTION material_limpieza_pendiente(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION material_limpieza_pendiente(integer) TO service_role;


-- ── 2. Retirar material: idempotente ─────────────────────────────────────────
-- Recreada desde 20260920220000_material_de_sesiones.sql (cambios PKG-06E marcados).
CREATE OR REPLACE FUNCTION staff_eliminar_material(p_material_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_mat material_sesion;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo el equipo del estudio puede retirar material';
  END IF;
  -- PKG-06E: se busca también lo ya retirado (del mismo estudio) para converger.
  SELECT * INTO v_mat FROM material_sesion WHERE id = p_material_id AND tenant_id = v_tenant;
  IF v_mat.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MATERIAL_NO_EXISTE: Material no encontrado';
  END IF;

  -- PKG-06E: retirar dos veces converge. Mismo resultado y la misma ruta (la
  -- deriva la base) para reintentar el borrado del objeto; sin otra auditoría.
  IF v_mat.eliminado_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'ya_retirado', true, 'storage_path', v_mat.storage_path);
  END IF;

  UPDATE material_sesion SET eliminado_at = now() WHERE id = v_mat.id;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'material_retirado', 'usuario', v_mat.usuario_id,
          jsonb_build_object('titulo', v_mat.titulo, 'tipo', v_mat.tipo),
          jsonb_build_object('material_id', v_mat.id, 'reserva_id', v_mat.reserva_id));

  -- El front intenta borrar el objeto con esta ruta; si no puede, el cron diario
  -- lo reintenta (material_limpieza_pendiente). El acceso ya terminó aquí.
  RETURN jsonb_build_object('success', true, 'ya_retirado', false, 'storage_path', v_mat.storage_path);
END;
$$;
REVOKE ALL ON FUNCTION staff_eliminar_material(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_eliminar_material(uuid) TO authenticated;


-- ── 3. Material pendiente: solo sesiones que ocurrieron y nunca recibieron nada ─
-- Recreada desde 20261007100000_material_pendiente_y_requerido.sql (PKG-06E).
CREATE OR REPLACE FUNCTION staff_listar_material_pendiente()
RETURNS TABLE (
  reserva_id uuid,
  usuario_id uuid,
  folio text,
  slot_inicio timestamptz,
  slot_fin timestamptz,
  recurso_nombre text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT r.id, r.usuario_id, r.folio, r.slot_inicio, r.slot_fin, rec.nombre
  FROM reservas r
  JOIN recursos rec ON rec.id = r.recurso_id
  WHERE r.tenant_id = get_my_tenant_id()
    AND is_recepcionista()
    AND r.material_requerido
    -- PKG-06E: la sesión consta como ocurrida (check-in). Una pasada sin check-in
    -- no es material pendiente: el cron de no-shows la resuelve.
    AND r.status = 'completada'
    AND r.slot_fin < now()
    -- PKG-06E: entregado alguna vez = no pendiente, aunque después venciera, lo
    -- barriera la limpieza o el staff lo retirara.
    AND NOT EXISTS (SELECT 1 FROM material_sesion m WHERE m.reserva_id = r.id)
  ORDER BY r.slot_fin ASC;
$$;
REVOKE ALL ON FUNCTION staff_listar_material_pendiente() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION staff_listar_material_pendiente() TO authenticated;


-- ── 4. v_pendientes_operativos (06B) + ramas de material ─────────────────────
CREATE OR REPLACE VIEW v_pendientes_operativos WITH (security_invoker = true) AS
SELECT 'finanzas'::text AS dominio, r.tipo, 'revisiones_financieras'::text AS fuente, r.id::text AS fuente_id,
       r.tenant_id,
       CASE WHEN (r.detalle ->> 'usuario_id') ~ '^[0-9a-f-]{36}$' THEN (r.detalle ->> 'usuario_id')::uuid END AS usuario_id,
       r.abierta_at AS desde, 'alta'::text AS severidad, 'resolver_revision'::text AS accion,
       '/admin/cobros'::text AS ruta, NULL::text AS detalle
FROM revisiones_financieras r
WHERE r.estado = 'abierta' AND r.tenant_id = get_my_tenant_id() AND is_admin()
UNION ALL
SELECT 'stripe', 'evento_' || e.estado, 'stripe_webhook_events', e.id,
       get_my_tenant_id(), NULL::uuid,
       COALESCE(e.ultimo_intento_at, e.received_at),
       CASE WHEN e.estado = 'revision' THEN 'alta' ELSE 'media' END,
       'resolver_evento', '/admin/operacion',
       e.type || COALESCE(' · ' || e.motivo, '')
FROM stripe_webhook_events e
WHERE is_admin() AND e.stripe_account IS NOT NULL AND e.stripe_account = _mi_cuenta_stripe()
  AND (e.estado = 'revision'
       OR (e.estado = 'error_reintentable' AND COALESCE(e.ultimo_intento_at, e.received_at) < now() - interval '6 hours')
       OR (e.estado = 'en_proceso' AND e.lease_hasta < now() - interval '1 hour'))
  AND (e.revisado_at IS NULL OR e.revisado_at < COALESCE(e.ultimo_intento_at, e.received_at))
UNION ALL
SELECT 'cobro', o.tipo, 'stripe_operaciones_suscripcion', o.id::text, o.tenant_id, o.usuario_id,
       COALESCE(o.ultimo_intento_at, o.created_at),
       -- PKG-06B: una suscripción anterior sin cancelar puede significar DOBLE COBRO.
       CASE WHEN o.reintentos_agotados_at IS NOT NULL OR o.causa = 'suscripcion_anterior' THEN 'alta' ELSE 'media' END,
       CASE WHEN o.tipo = 'cambiar_plan' THEN 'revisar_cambio_plan'
            WHEN o.reintentos_agotados_at IS NOT NULL THEN 'decidir_operacion' ELSE 'vigilar_operacion' END,
       '/admin/operacion',
       o.causa || COALESCE(' · ' || left(o.ultimo_error, 120), '')
FROM stripe_operaciones_suscripcion o
WHERE o.tenant_id = get_my_tenant_id() AND is_admin()
  AND (o.estado = 'fallida' OR (o.estado = 'pendiente' AND o.created_at < now() - interval '1 hour'))
UNION ALL
SELECT 'entrega', 'correo_aviso_fallido', 'notificaciones', n.id::text, n.tenant_id, n.usuario_id,
       n.creada_at, 'baja', 'atender_fallo_entrega', '/admin/operacion',
       n.tipo || COALESCE(' · ' || n.email_ultimo_error, '')
FROM notificaciones n
WHERE n.email_resultado = 'fallo' AND n.email_revisado_at IS NULL
  AND n.tenant_id = get_my_tenant_id() AND is_admin()
UNION ALL
SELECT 'entrega', 'correo_directo_fallido', 'correos_directos', c.idempotency_key, c.tenant_id, c.usuario_id,
       c.ultimo_intento_at, 'media', 'atender_fallo_entrega', '/admin/operacion',
       c.plantilla || COALESCE(' · ' || c.ultimo_error, '')
FROM correos_directos c
WHERE c.resultado = 'fallo' AND c.revisado_at IS NULL
  AND c.tenant_id = get_my_tenant_id() AND is_admin()
UNION ALL
SELECT 'membresia', d.codigo, 'v_reconciliacion_membresia', v.usuario_id::text, v.tenant_id, v.usuario_id,
       NULL::timestamptz, 'media', 'revisar_miembro', '/admin/miembros/' || v.usuario_id::text, NULL::text
FROM v_reconciliacion_membresia v
CROSS JOIN LATERAL unnest(v.divergencias) AS d(codigo)
WHERE v.tenant_id = get_my_tenant_id() AND is_admin()
  AND d.codigo IN ('activo_sin_derecho', 'activa_id_invalido', 'membresia_vencida_sin_expirar',
                   'varias_membresias_vivas', 'stripe_contradictorio', 'stripe_customer_distinto')
UNION ALL
SELECT 'stripe', 'discrepancia_' || d.tipo, 'discrepancias_stripe', d.id::text, d.tenant_id, d.usuario_id,
       d.detectada_at,
       CASE WHEN d.revisada_at IS NOT NULL THEN 'baja'
            WHEN d.tipo IN ('suscripcion_huerfana', 'pausa_distinta', 'estado_distinto') THEN 'alta' ELSE 'media' END,
       CASE WHEN d.revisada_at IS NOT NULL THEN 'discrepancia_revisada' ELSE 'revisar_discrepancia' END,
       '/admin/operacion',
       d.stripe_subscription_id || COALESCE(' · EKKO: ' || (d.esperado ->> 'resumen'), '')
         || COALESCE(' · Stripe: ' || (d.observado ->> 'resumen'), '') || ' · vista ' || d.veces || 'x'
FROM discrepancias_stripe d
WHERE d.estado = 'abierta' AND d.tenant_id = get_my_tenant_id() AND is_admin()
UNION ALL
SELECT 'stripe', 'reconciliacion_' || c.estado, 'reconciliacion_stripe_corridas', c.id::text, c.tenant_id, NULL::uuid,
       c.iniciada_at, 'media', 'reconciliacion_incompleta', '/admin/operacion', c.error
FROM (SELECT DISTINCT ON (x.tenant_id) x.* FROM reconciliacion_stripe_corridas x
      WHERE x.tenant_id = get_my_tenant_id() ORDER BY x.tenant_id, x.iniciada_at DESC) c
WHERE c.estado <> 'completa' AND is_admin()
-- ── PKG-06G ──────────────────────────────────────────────────────────────────
UNION ALL
-- Proceso programado atrasado (sin éxito dentro de su umbral; si nunca corrió,
-- tras max(umbral, 2 h) desde que se vigila) o fallando (N fallos seguidos).
-- Se deriva AL LEER: un cron muerto no necesita reportar su propia muerte.
SELECT 'procesos',
       CASE WHEN x.atrasado THEN 'proceso_atrasado' ELSE 'proceso_fallando' END,
       'procesos_programados', p.proceso, get_my_tenant_id(), NULL::uuid,
       CASE WHEN x.atrasado THEN COALESCE(p.ultimo_exito_at, p.vigilado_desde) ELSE p.ultimo_fallo_at END,
       p.severidad, 'revisar_proceso', '/admin/operacion',
       p.proceso || ' · ' || p.cadencia
         || ' · último estado: ' || COALESCE(p.ultimo_estado, 'nunca corrió')
         || COALESCE(' (' || p.ultima_clase_error || ')', '')
         || CASE WHEN p.fallos_seguidos > 0 THEN ' · ' || p.fallos_seguidos || ' fallos seguidos' ELSE '' END
FROM procesos_programados p
CROSS JOIN LATERAL (SELECT
  (p.ultimo_exito_at IS NOT NULL AND p.ultimo_exito_at < now() - p.umbral_atraso)
  OR (p.ultimo_exito_at IS NULL AND p.vigilado_desde < now() - GREATEST(p.umbral_atraso, interval '2 hours')) AS atrasado) x
WHERE is_admin()
  AND (x.atrasado OR p.fallos_seguidos >= p.fallos_para_alertar)
UNION ALL
-- Reconciliación con Stripe atrasada: derivada de las corridas de 03B (sin latido
-- duplicado). Solo para estudios que ya tienen corridas (los que se reconcilian).
SELECT 'stripe', 'reconciliacion_atrasada', 'reconciliacion_stripe_corridas', c.id::text, c.tenant_id, NULL::uuid,
       c.iniciada_at, 'media', 'reconciliacion_atrasada', '/admin/operacion', 'cron-reconciliar-stripe · 0 9 * * *'
FROM (SELECT DISTINCT ON (x.tenant_id) x.* FROM reconciliacion_stripe_corridas x
      WHERE x.tenant_id = get_my_tenant_id() ORDER BY x.tenant_id, x.iniciada_at DESC) c
WHERE c.iniciada_at < now() - interval '26 hours' AND is_admin()
UNION ALL
-- Avisos push no entregados, AGREGADOS por estudio: cuántos y de qué tipo. Sin
-- destinatario, endpoint, llaves ni contenido. El aviso sigue en la campana.
SELECT 'entrega', 'push_no_entregado', 'notificaciones_push', 'push:' || f.tenant_id::text, f.tenant_id, NULL::uuid,
       f.desde, 'baja', 'revisar_fallos_push', '/admin/operacion',
       f.total || ' sin entregar'
         || CASE WHEN f.sin_config > 0 THEN ' (' || f.sin_config || ' por falta de configuración)' ELSE '' END
         || ' · ' || f.tipos
FROM resumen_fallos_push() f
-- ── PKG-06E · material: fila ↔ objeto en Storage (metadatos, misma base) ─────
-- security_invoker: el admin lee `material_sesion` (material_read_staff) y los
-- objetos de la carpeta de SU estudio (material_staff_all). Sin rutas en el texto.
UNION ALL
-- El miembro ve este material (vivo) pero su archivo no está: no podrá bajarlo.
SELECT 'material', 'material_sin_archivo', 'material_sesion', m.id::text, m.tenant_id, m.usuario_id,
       m.created_at, 'media', 'revisar_material_sin_archivo', '/admin/miembros/' || m.usuario_id::text,
       m.titulo
FROM material_sesion m
WHERE m.tenant_id = get_my_tenant_id() AND is_admin()
  AND m.tipo = 'archivo' AND m.eliminado_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'material' AND o.name = m.storage_path
      AND COALESCE((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false)
UNION ALL
-- Retirados o vencidos hace más de 2 días que siguen ocupando espacio: la
-- limpieza diaria no ha convergido. Un renglón por estudio (sin duplicados).
SELECT 'material', 'material_limpieza_atascada', 'material_sesion', 'limpieza:' || x.tenant_id::text, x.tenant_id, NULL::uuid,
       x.desde, 'baja', 'revisar_limpieza_material', '/admin/operacion',
       x.n || CASE WHEN x.n = 1 THEN ' archivo retirado sigue' ELSE ' archivos retirados siguen' END || ' en el almacenamiento'
FROM (
  SELECT m.tenant_id, count(*) AS n, min(m.eliminado_at) AS desde
  FROM material_sesion m
  WHERE m.tenant_id = get_my_tenant_id() AND is_admin()
    AND m.tipo = 'archivo' AND m.eliminado_at < now() - interval '2 days'
    AND EXISTS (
      SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'material' AND o.name = m.storage_path
        AND COALESCE((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false)
  GROUP BY m.tenant_id
) x
UNION ALL
-- Objetos en la carpeta del estudio sin NINGUNA fila que los nombre (p. ej. una
-- subida cuyo registro falló y cuya limpieza también). Más de 1 h (no es una
-- subida en curso). Agregado por estudio. EKKO NUNCA los borra solo.
SELECT 'material', 'material_objeto_huerfano', 'storage.objects', 'huerfanos:' || x.tenant_id::text, x.tenant_id, NULL::uuid,
       x.desde, 'baja', 'revisar_objeto_huerfano', '/admin/operacion',
       x.n || CASE WHEN x.n = 1 THEN ' archivo' ELSE ' archivos' END || ' sin material registrado · '
         || CASE WHEN x.bytes >= 1048576 THEN round(x.bytes / 1048576.0) || ' MB' ELSE ceil(x.bytes / 1024.0) || ' KB' END
FROM (
  SELECT get_my_tenant_id() AS tenant_id, count(*) AS n, min(o.created_at) AS desde,
         COALESCE(sum(CASE WHEN (o.metadata ->> 'size') ~ '^[0-9]+$' THEN (o.metadata ->> 'size')::bigint END), 0) AS bytes
  FROM storage.objects o
  WHERE is_admin()
    AND o.bucket_id = 'material'
    AND split_part(o.name, '/', 1) = get_my_tenant_id()::text
    AND o.created_at < now() - interval '1 hour'
    AND COALESCE((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false
    AND NOT EXISTS (SELECT 1 FROM material_sesion m WHERE m.storage_path = o.name)
) x
WHERE x.n > 0;

REVOKE ALL ON v_pendientes_operativos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON v_pendientes_operativos TO authenticated;
