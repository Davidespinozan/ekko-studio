-- ============================================================================
-- PKG-06G · Señales operativas durables (EKKO-144)
-- ============================================================================
-- Sentry no está configurado en producción: un cron que falla o deja de correr
-- solo dejaba rastro en los logs de Netlify (FR-50), y un push que no se entregó
-- quedaba en `notificaciones.push_resultado` sin que nadie lo viera (FR-51).
--
--  1. `procesos_programados`: UNA fila de estado actual por proceso programado
--     que importa (no un log de latidos). Catálogo fijo con su umbral de atraso,
--     cuántos fallos seguidos ameritan aviso y su severidad. Global: los crons
--     corren para todos los estudios a la vez (no hay estudio dueño).
--  2. `registrar_ejecucion_proceso`: única escritura, solo service_role, con
--     identificadores y clases de error fijos. Ningún texto de error crudo.
--  3. `v_pendientes_operativos` (recreada con TODAS sus ramas previas idénticas)
--     suma tres ramas DERIVADAS al leerla, sin depender del cron que vigila:
--       · proceso atrasado (sin éxito dentro de su umbral) o fallando;
--       · reconciliación con Stripe atrasada, derivada de
--         `reconciliacion_stripe_corridas` (03B ya la registra: sin latido duplicado);
--       · avisos push que no se entregaron, agregados por estudio, sin endpoint,
--         llaves ni contenido.
--  4. `revisar_fallos_push(nota)`: el admin deja constancia de que los vio
--     (push es entrega opcional: el aviso sigue en la campana; no hay reintento).
--
-- Aditiva y compatible con el código desplegado: el código viejo no registra
-- ejecuciones, y el primer aviso de "nunca corrió" espera max(umbral, 2 h) desde
-- `vigilado_desde`, ventana suficiente para desplegar el código nuevo.
-- ============================================================================

-- ── 1. Estado actual de los procesos programados ─────────────────────────────
CREATE TABLE IF NOT EXISTS procesos_programados (
  proceso              text PRIMARY KEY
                       CHECK (proceso IN ('cron-expirar-membresias', 'cron-no-shows', 'cron-email',
                                          'cron-push', 'cron-recordatorios', 'cron-material-vencido')),
  descripcion          text NOT NULL,
  cadencia             text NOT NULL,                 -- expresión cron (para humanos)
  umbral_atraso        interval NOT NULL,             -- sin éxito en este lapso = atrasado
  fallos_para_alertar  integer NOT NULL CHECK (fallos_para_alertar >= 1),
  severidad            text NOT NULL CHECK (severidad IN ('alta', 'media')),
  vigilado_desde       timestamptz NOT NULL DEFAULT now(),
  ultima_ejecucion_at  timestamptz,
  ultimo_exito_at      timestamptz,
  ultimo_fallo_at      timestamptz,
  ultimo_estado        text CHECK (ultimo_estado IN ('exito', 'parcial', 'fallo', 'omitido')),
  ultima_clase_error   text CHECK (ultima_clase_error IN ('base_datos', 'proveedor', 'almacenamiento', 'configuracion', 'interno')),
  fallos_seguidos      integer NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE procesos_programados IS
  'PKG-06G: estado actual (una fila por proceso) de los crons que importan. Lo escribe solo registrar_ejecucion_proceso (service_role). El atraso se DERIVA al leer v_pendientes_operativos.';

-- Catálogo (configuración, no datos de negocio). Umbrales desde el horario real:
--  · expirar-membresias 0 7 * * *   → 26 h  (diario + 2 h de gracia) · alta, 1 fallo
--  · no-shows           0 * * * *   → 3 h   (3 corridas perdidas)    · alta, 2 fallos
--  · email              */2 * * * * → 20 min (10 corridas)           · media, 5 fallos
--  · push               * * * * *   → 15 min (15 corridas)           · media, 10 fallos
--  · recordatorios      */15 * * * * → 1 h  (4 corridas)             · media, 3 fallos
--  · material-vencido   30 10 * * * → 26 h                           · media, 1 fallo
-- Fuera del catálogo: cron-reconciliar-stripe (su evidencia es la corrida de 03B),
-- cron-membresias-por-vencer y cron-felicitaciones (cortesía; perderlos no rompe
-- ningún invariante).
INSERT INTO procesos_programados (proceso, descripcion, cadencia, umbral_atraso, fallos_para_alertar, severidad) VALUES
  ('cron-expirar-membresias', 'Expira membresías vencidas, cancela suscripciones huérfanas y reintenta cambios de cobro', '0 7 * * *', interval '26 hours', 1, 'alta'),
  ('cron-no-shows', 'Marca inasistencias y aplica la penalización', '0 * * * *', interval '3 hours', 2, 'alta'),
  ('cron-email', 'Envía los correos de los avisos', '*/2 * * * *', interval '20 minutes', 5, 'media'),
  ('cron-push', 'Envía los avisos push', '* * * * *', interval '15 minutes', 10, 'media'),
  ('cron-recordatorios', 'Crea los recordatorios de reserva', '*/15 * * * *', interval '1 hour', 3, 'media'),
  ('cron-material-vencido', 'Borra el material de sesión vencido', '30 10 * * *', interval '26 hours', 1, 'media')
ON CONFLICT (proceso) DO NOTHING;

ALTER TABLE procesos_programados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS procesos_programados_read_admin ON procesos_programados;
CREATE POLICY procesos_programados_read_admin ON procesos_programados
  FOR SELECT TO authenticated USING (is_admin());
REVOKE ALL ON procesos_programados FROM PUBLIC, anon, authenticated;
GRANT SELECT ON procesos_programados TO authenticated;
GRANT SELECT ON procesos_programados TO service_role;

-- ── 2. Única escritura: el cron asienta el resultado de SU corrida ───────────
-- exito    : la iteración prevista terminó.          → último éxito, fallos = 0
-- parcial  : terminó, pero un paso secundario falló. → último éxito y fallo, fallos + 1
-- fallo    : la iteración no terminó.                → último fallo, fallos + 1
-- omitido  : no corrió por falta de configuración.   → no cuenta como éxito (se atrasará)
CREATE OR REPLACE FUNCTION registrar_ejecucion_proceso(p_proceso text, p_estado text, p_clase_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v procesos_programados;
BEGIN
  IF p_estado NOT IN ('exito', 'parcial', 'fallo', 'omitido') THEN
    RAISE EXCEPTION 'EKKO_ESTADO_INVALIDO: %', p_estado;
  END IF;
  IF p_clase_error IS NOT NULL AND p_clase_error NOT IN ('base_datos', 'proveedor', 'almacenamiento', 'configuracion', 'interno') THEN
    RAISE EXCEPTION 'EKKO_CLASE_INVALIDA: %', p_clase_error;
  END IF;
  UPDATE procesos_programados
  SET ultima_ejecucion_at = now(),
      ultimo_exito_at     = CASE WHEN p_estado IN ('exito', 'parcial') THEN now() ELSE ultimo_exito_at END,
      ultimo_fallo_at     = CASE WHEN p_estado IN ('parcial', 'fallo') THEN now() ELSE ultimo_fallo_at END,
      fallos_seguidos     = CASE WHEN p_estado = 'exito' THEN 0
                                 WHEN p_estado IN ('parcial', 'fallo') THEN fallos_seguidos + 1
                                 ELSE fallos_seguidos END,
      ultimo_estado       = p_estado,
      ultima_clase_error  = CASE WHEN p_estado = 'exito' THEN NULL ELSE p_clase_error END,
      updated_at          = now()
  WHERE proceso = p_proceso
  RETURNING * INTO v;
  IF v.proceso IS NULL THEN
    RAISE EXCEPTION 'EKKO_PROCESO_DESCONOCIDO: %', p_proceso;
  END IF;
  RETURN jsonb_build_object('proceso', v.proceso, 'estado', v.ultimo_estado, 'fallos_seguidos', v.fallos_seguidos);
END;
$$;
REVOKE ALL ON FUNCTION registrar_ejecucion_proceso(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION registrar_ejecucion_proceso(text, text, text) TO service_role;

-- ── 3. Revisión de avisos push no entregados ────────────────────────────────
ALTER TABLE notificaciones
  ADD COLUMN IF NOT EXISTS push_revisado_at  timestamptz,
  ADD COLUMN IF NOT EXISTS push_revisado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS notificaciones_push_fallido_idx
  ON notificaciones (tenant_id, creada_at)
  WHERE push_resultado IN ('fallo', 'sin_config') AND push_revisado_at IS NULL;

-- El admin deja constancia de que vio los avisos push sin entregar de su estudio
-- (todos los pendientes de revisar hasta ahora). No reenvía nada: push es entrega
-- opcional y el aviso sigue en la campana del destinatario.
CREATE OR REPLACE FUNCTION revisar_fallos_push(p_nota text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_n integer;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede revisar los avisos push no entregados';
  END IF;
  IF COALESCE(length(trim(p_nota)), 0) < 10 THEN
    RAISE EXCEPTION 'EKKO_NOTA_REQUERIDA: Explica qué se hizo (mínimo 10 caracteres)';
  END IF;
  UPDATE notificaciones SET push_revisado_at = now(), push_revisado_por = v_actor
  WHERE tenant_id = v_tenant AND push_resultado IN ('fallo', 'sin_config') AND push_revisado_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('success', true, 'revisados', 0, 'idempotente', true);
  END IF;
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, motivo, metadata)
  VALUES (v_tenant, v_actor, get_my_rol(), 'fallos_push_revisados', 'tenant', v_tenant, trim(p_nota),
          jsonb_build_object('revisados', v_n));
  RETURN jsonb_build_object('success', true, 'revisados', v_n, 'idempotente', false);
END;
$$;
REVOKE ALL ON FUNCTION revisar_fallos_push(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revisar_fallos_push(text) TO authenticated;

-- Resumen AGREGADO de push no entregados del estudio del admin. El admin no lee
-- por RLS los avisos de otros (03A solo le abre los correos fallidos), y no se
-- amplía esa política: esta función devuelve solo cuántos, desde cuándo y de qué
-- tipo — nunca destinatario, título, mensaje, endpoint ni llaves.
CREATE OR REPLACE FUNCTION resumen_fallos_push()
RETURNS TABLE (tenant_id uuid, desde timestamptz, total bigint, sin_config bigint, tipos text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.tenant_id, min(n.creada_at), count(*), count(*) FILTER (WHERE n.push_resultado = 'sin_config'),
         string_agg(DISTINCT n.tipo, ', ')
  FROM notificaciones n
  WHERE is_admin() AND n.tenant_id = get_my_tenant_id()
    AND n.push_resultado IN ('fallo', 'sin_config') AND n.push_revisado_at IS NULL
  GROUP BY n.tenant_id;
$$;
REVOKE ALL ON FUNCTION resumen_fallos_push() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resumen_fallos_push() TO authenticated, service_role;

-- ── 4. v_pendientes_operativos: ramas previas idénticas + tres derivadas ────
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
       CASE WHEN o.reintentos_agotados_at IS NOT NULL THEN 'alta' ELSE 'media' END,
       CASE WHEN o.reintentos_agotados_at IS NOT NULL THEN 'decidir_operacion' ELSE 'vigilar_operacion' END,
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
FROM resumen_fallos_push() f;

REVOKE ALL ON v_pendientes_operativos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON v_pendientes_operativos TO authenticated;
