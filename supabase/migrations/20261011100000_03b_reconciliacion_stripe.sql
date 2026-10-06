-- ============================================================================
-- PKG-03B · RECONCILIADOR STRIPE (DETECT-ONLY) · D-03B-1 = A
-- ----------------------------------------------------------------------------
-- Compara lo que EKKO espera con lo que Stripe contiene y deja EVIDENCIA durable
-- de cada diferencia. NUNCA repara (ni Stripe ni EKKO). La única automatización
-- de reparación sigue siendo la que ya existía: la cancelación de suscripciones
-- huérfanas de las últimas 48 h en cron-expirar-membresias (sin cambios).
--
--  · discrepancias_stripe: UNA fila ABIERTA por (tenant, suscripción, tipo). Cada
--    corrida que la vuelve a ver actualiza la misma fila (vista_at, veces). Una
--    corrida COMPLETA del estudio que ya no la ve la cierra (`convergio`). Si
--    reaparece después, es un EPISODIO nuevo (fila nueva): la historia no se
--    reescribe. Revisarla (admin, con nota) NO la cierra: leída ≠ resuelta.
--  · reconciliacion_stripe_corridas: una fila por estudio y corrida (completa |
--    parcial | fallida). Parcial o fallida NUNCA cierra discrepancias; el "falta
--    en Stripe" solo se afirma con la lectura completa del estudio (lo decide el
--    detector antes de llamar aquí).
--  · Snapshots mínimos: estado, pausa, cancel_at_period_end, tier en metadata,
--    resumen legible. Sin payload de Stripe, sin secretos, sin PII.
--  · v_pendientes_operativos (PKG-03A) gana dos ramas derivadas: discrepancias
--    abiertas y la última corrida no completa del estudio.
--
-- Aditiva. No cambia el cuerpo de ninguna función existente.
-- Pruebas: src/__tests__/db/03b-reconciliacion-stripe.db.test.ts
-- ============================================================================

CREATE TABLE IF NOT EXISTS reconciliacion_stripe_corridas (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corrida_id             uuid NOT NULL,
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  estado                 text NOT NULL CHECK (estado IN ('completa', 'parcial', 'fallida')),
  suscripciones_leidas   integer NOT NULL DEFAULT 0 CHECK (suscripciones_leidas >= 0),
  abiertas_nuevas        integer NOT NULL DEFAULT 0,
  actualizadas           integer NOT NULL DEFAULT 0,
  cerradas               integer NOT NULL DEFAULT 0,
  error                  text,
  iniciada_at            timestamptz NOT NULL DEFAULT now(),
  terminada_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (corrida_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS reconciliacion_stripe_corridas_tenant_idx
  ON reconciliacion_stripe_corridas (tenant_id, iniciada_at DESC);
COMMENT ON TABLE reconciliacion_stripe_corridas IS
  'PKG-03B: resultado de cada corrida del reconciliador por estudio. Parcial/fallida no cierra discrepancias.';

CREATE TABLE IF NOT EXISTS discrepancias_stripe (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  stripe_subscription_id  text NOT NULL,
  membresia_id            uuid REFERENCES membresias(id) ON DELETE SET NULL,
  usuario_id              uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo                    text NOT NULL CHECK (tipo IN ('suscripcion_ausente', 'suscripcion_huerfana', 'estado_distinto',
                                                         'pausa_distinta', 'cancelacion_distinta', 'plan_distinto')),
  esperado                jsonb NOT NULL DEFAULT '{}'::jsonb,
  observado               jsonb NOT NULL DEFAULT '{}'::jsonb,
  estado                  text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'resuelta')),
  resolucion              text CHECK (resolucion IS NULL OR resolucion = 'convergio'),
  detectada_at            timestamptz NOT NULL DEFAULT now(),
  vista_at                timestamptz NOT NULL DEFAULT now(),
  veces                   integer NOT NULL DEFAULT 1 CHECK (veces >= 1),
  ultima_corrida_id       uuid,
  resuelta_at             timestamptz,
  revisada_at             timestamptz,
  revisada_por            uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  nota_revision           text,
  CHECK ((estado = 'abierta' AND resolucion IS NULL AND resuelta_at IS NULL)
         OR (estado = 'resuelta' AND resolucion IS NOT NULL AND resuelta_at IS NOT NULL)),
  CHECK (revisada_at IS NULL OR nota_revision IS NOT NULL)
);
-- Como máximo UNA abierta por identidad lógica.
CREATE UNIQUE INDEX IF NOT EXISTS discrepancias_stripe_abierta_uniq
  ON discrepancias_stripe (tenant_id, stripe_subscription_id, tipo) WHERE estado = 'abierta';
CREATE INDEX IF NOT EXISTS discrepancias_stripe_tenant_idx ON discrepancias_stripe (tenant_id, estado, detectada_at);
COMMENT ON TABLE discrepancias_stripe IS
  'PKG-03B: diferencia observada entre lo que EKKO espera y lo que Stripe contiene. Evidencia para revisión humana; nadie repara desde aquí.';

ALTER TABLE reconciliacion_stripe_corridas ENABLE ROW LEVEL SECURITY;
ALTER TABLE discrepancias_stripe ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reconciliacion_stripe_corridas_admin_read ON reconciliacion_stripe_corridas;
CREATE POLICY reconciliacion_stripe_corridas_admin_read ON reconciliacion_stripe_corridas
  FOR SELECT TO authenticated USING (tenant_id = get_my_tenant_id() AND is_admin());
DROP POLICY IF EXISTS discrepancias_stripe_admin_read ON discrepancias_stripe;
CREATE POLICY discrepancias_stripe_admin_read ON discrepancias_stripe
  FOR SELECT TO authenticated USING (tenant_id = get_my_tenant_id() AND is_admin());
REVOKE ALL ON reconciliacion_stripe_corridas, discrepancias_stripe FROM PUBLIC, anon, authenticated;
GRANT SELECT ON reconciliacion_stripe_corridas, discrepancias_stripe TO authenticated;

-- Asienta lo observado en UNA corrida para UN estudio. Solo service_role (el
-- reconciliador). `p_discrepancias` = lista completa de lo que se vio divergente:
-- [{stripe_subscription_id, tipo, membresia_id?, usuario_id?, esperado, observado}].
CREATE OR REPLACE FUNCTION registrar_reconciliacion_stripe(
  p_corrida_id uuid, p_tenant_id uuid, p_estado text, p_suscripciones_leidas integer,
  p_discrepancias jsonb, p_error text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_d jsonb;
  v_nuevas integer := 0;
  v_act integer := 0;
  v_cerradas integer := 0;
  v_vistas text[] := ARRAY[]::text[];
  v_id uuid;
BEGIN
  IF p_estado NOT IN ('completa', 'parcial', 'fallida') THEN
    RAISE EXCEPTION 'EKKO_ESTADO_INVALIDO: %', p_estado;
  END IF;
  IF EXISTS (SELECT 1 FROM reconciliacion_stripe_corridas WHERE corrida_id = p_corrida_id AND tenant_id = p_tenant_id) THEN
    RETURN jsonb_build_object('idempotente', true);
  END IF;
  IF p_estado = 'fallida' AND jsonb_array_length(COALESCE(p_discrepancias, '[]'::jsonb)) > 0 THEN
    RAISE EXCEPTION 'EKKO_CORRIDA_FALLIDA_CON_DATOS: una corrida fallida no aporta observaciones';
  END IF;

  FOR v_d IN SELECT * FROM jsonb_array_elements(COALESCE(p_discrepancias, '[]'::jsonb)) LOOP
    v_vistas := v_vistas || ((v_d ->> 'stripe_subscription_id') || '|' || (v_d ->> 'tipo'));
    UPDATE discrepancias_stripe
    SET vista_at = now(), veces = veces + 1, ultima_corrida_id = p_corrida_id,
        esperado = COALESCE(v_d -> 'esperado', '{}'::jsonb), observado = COALESCE(v_d -> 'observado', '{}'::jsonb),
        membresia_id = COALESCE((v_d ->> 'membresia_id')::uuid, membresia_id),
        usuario_id = COALESCE((v_d ->> 'usuario_id')::uuid, usuario_id)
    WHERE tenant_id = p_tenant_id AND stripe_subscription_id = v_d ->> 'stripe_subscription_id'
      AND tipo = v_d ->> 'tipo' AND estado = 'abierta'
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      v_act := v_act + 1;
    ELSE
      INSERT INTO discrepancias_stripe (tenant_id, stripe_subscription_id, membresia_id, usuario_id, tipo, esperado, observado, ultima_corrida_id)
      VALUES (p_tenant_id, v_d ->> 'stripe_subscription_id', (v_d ->> 'membresia_id')::uuid, (v_d ->> 'usuario_id')::uuid,
              v_d ->> 'tipo', COALESCE(v_d -> 'esperado', '{}'::jsonb), COALESCE(v_d -> 'observado', '{}'::jsonb), p_corrida_id);
      v_nuevas := v_nuevas + 1;
    END IF;
    v_id := NULL;
  END LOOP;

  -- Solo una corrida COMPLETA del estudio prueba que lo que no se vio convergió.
  IF p_estado = 'completa' THEN
    UPDATE discrepancias_stripe
    SET estado = 'resuelta', resolucion = 'convergio', resuelta_at = now()
    WHERE tenant_id = p_tenant_id AND estado = 'abierta'
      AND NOT ((stripe_subscription_id || '|' || tipo) = ANY (v_vistas));
    GET DIAGNOSTICS v_cerradas = ROW_COUNT;
  END IF;

  INSERT INTO reconciliacion_stripe_corridas (corrida_id, tenant_id, estado, suscripciones_leidas, abiertas_nuevas, actualizadas, cerradas, error)
  VALUES (p_corrida_id, p_tenant_id, p_estado, GREATEST(COALESCE(p_suscripciones_leidas, 0), 0), v_nuevas, v_act, v_cerradas,
          left(NULLIF(trim(COALESCE(p_error, '')), ''), 300));
  RETURN jsonb_build_object('idempotente', false, 'nuevas', v_nuevas, 'actualizadas', v_act, 'cerradas', v_cerradas);
END;
$$;
REVOKE ALL ON FUNCTION registrar_reconciliacion_stripe(uuid, uuid, text, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION registrar_reconciliacion_stripe(uuid, uuid, text, integer, jsonb, text) TO service_role;

-- Revisar = el admin dejó constancia (nota). NO la cierra: sigue abierta mientras
-- Stripe y EKKO no coincidan; solo el detector la cierra al converger.
CREATE OR REPLACE FUNCTION revisar_discrepancia_stripe(p_discrepancia_id uuid, p_nota text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_rol text := get_my_rol();
  v_d discrepancias_stripe;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede revisar discrepancias de Stripe';
  END IF;
  IF COALESCE(length(trim(p_nota)), 0) < 10 THEN
    RAISE EXCEPTION 'EKKO_NOTA_REQUERIDA: Explica qué revisaste (mínimo 10 caracteres)';
  END IF;
  SELECT * INTO v_d FROM discrepancias_stripe WHERE id = p_discrepancia_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_d.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_DISCREPANCIA_INVALIDA: No encontrada o de otro estudio';
  END IF;
  IF v_d.estado <> 'abierta' THEN
    RAISE EXCEPTION 'EKKO_DISCREPANCIA_CERRADA: Ya convergió';
  END IF;
  IF v_d.revisada_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true);
  END IF;
  UPDATE discrepancias_stripe SET revisada_at = now(), revisada_por = v_actor, nota_revision = trim(p_nota) WHERE id = v_d.id;
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'discrepancia_stripe_revisada', 'discrepancia_stripe', v_d.id,
          jsonb_build_object('estado', 'abierta', 'revisada', false), jsonb_build_object('estado', 'abierta', 'revisada', true),
          trim(p_nota), jsonb_build_object('tipo', v_d.tipo, 'stripe_subscription_id', v_d.stripe_subscription_id));
  RETURN jsonb_build_object('success', true, 'idempotente', false);
END;
$$;
REVOKE ALL ON FUNCTION revisar_discrepancia_stripe(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION revisar_discrepancia_stripe(uuid, text) TO authenticated;

-- PKG-03A + dos ramas derivadas de PKG-03B (mismas columnas, mismo orden).
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
WHERE c.estado <> 'completa' AND is_admin();

REVOKE ALL ON v_pendientes_operativos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON v_pendientes_operativos TO authenticated;
