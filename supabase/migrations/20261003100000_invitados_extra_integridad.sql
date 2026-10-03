-- ============================================================================
-- PKG-01H · INTEGRIDAD DE INVITADOS (C20) — W-1=B, W-2=A, W-3=A
-- ----------------------------------------------------------------------------
-- Antes:
--   · `registrar_invitados_extra_pagados(reserva, cantidad)` SUMABA sin llave:
--     si un paso posterior del webhook fallaba (diario, finalizar), el reintento
--     volvía a sumar → invitados extra sin pago (S-1).
--   · El tope de extras solo se miraba al CREAR el PaymentIntent; al acreditar no
--     se revisaba tope, estado, fecha, tenant ni monto (S-2).
--   · Recepción registraba fichas de invitados sin tope ni estado, y clasificaba
--     "extra" con el plan cacheado del miembro (S-4).
-- Ahora:
--   · `invitados_extra_pagos`: evidencia CANÓNICA, una fila por PaymentIntent
--     (UNIQUE), inmutable, con su resultado final: aplicado | no_aplicado+motivo.
--   · `reservas.invitados_extra_pagados` es CACHÉ derivada:
--       = SUM(cantidad) de las filas 'aplicado' de la reserva,
--     mantenida SOLO por `aplicar_invitados_extra_pago` en la misma transacción.
--     Si alguien la tocó por fuera (REST admin, residual de PKG-01L), la próxima
--     aplicación NO suma sobre un contador corrupto: queda no_aplicado /
--     contador_inconsistente + revisión. Nunca se repara sola.
--   · Un PI que no puede aplicarse NO desaparece: evidencia no_aplicado + revisión
--     financiera 'invitados_extra_no_aplicado' (extensión aditiva de PKG-01G).
--     Cero mutación automática de derechos, cero reembolso automático (D7).
--   · Fichas de recepción: `registrar_ficha_invitado` bloquea la reserva y no deja
--     pasar de invitados_count + invitados_extra_pagados; es_extra sale de la
--     reserva, no del plan cacheado.
--   · `capacidad_personas` queda INFORMATIVO (W-1=B): no se aplica en ningún lado.
--
-- Aditiva: sin UPDATE de datos, sin backfill (producción: 0 extras, 0 PI de
-- extras, 0 fichas). No toca R1, 01A (claim/finalizar), 01F ni la semántica de
-- reversals de 01G.
-- ============================================================================

-- ── 1. No negatividad (NOT VALID → VALIDATE: no bloquea escrituras largas) ───
ALTER TABLE reservas
  ADD CONSTRAINT reservas_invitados_count_no_negativo CHECK (invitados_count >= 0) NOT VALID;
ALTER TABLE reservas VALIDATE CONSTRAINT reservas_invitados_count_no_negativo;
ALTER TABLE reservas
  ADD CONSTRAINT reservas_invitados_extra_pagados_no_negativo CHECK (invitados_extra_pagados >= 0) NOT VALID;
ALTER TABLE reservas VALIDATE CONSTRAINT reservas_invitados_extra_pagados_no_negativo;

COMMENT ON COLUMN reservas.invitados_extra_pagados IS
  'PKG-01H: caché derivada = SUM(cantidad) de invitados_extra_pagos aplicados. Solo la mantiene aplicar_invitados_extra_pago.';
COMMENT ON COLUMN recursos.capacidad_personas IS
  'INFORMATIVO (PKG-01H, W-1=B): no es límite de reserva ni de invitados. El estudio se renta en exclusiva; los topes son tiers.reglas.max_invitados y recursos.max_invitados_extra.';

-- ── 2. Evidencia canónica por PaymentIntent ──────────────────────────────────
CREATE TABLE IF NOT EXISTS invitados_extra_pagos (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  reserva_id                 uuid NOT NULL REFERENCES reservas(id) ON DELETE RESTRICT,
  stripe_payment_intent_id   text NOT NULL UNIQUE,
  stripe_account             text NOT NULL,
  stripe_event_id            text NOT NULL,
  cantidad                   integer NOT NULL CHECK (cantidad > 0),
  monto_centavos             integer NOT NULL CHECK (monto_centavos > 0),
  precio_unitario_centavos   integer CHECK (precio_unitario_centavos IS NULL OR precio_unitario_centavos > 0),
  moneda                     text NOT NULL,
  estado                     text NOT NULL CHECK (estado IN ('aplicado', 'no_aplicado')),
  motivo                     text,
  pagado_at                  timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitados_extra_pagos_motivo_check CHECK (
    (estado = 'aplicado' AND motivo IS NULL)
    OR (estado = 'no_aplicado' AND motivo IN ('reserva_no_aplicable', 'reserva_pasada', 'tenant_incompatible',
                                              'excede_tope', 'monto_no_coincide', 'sin_snapshot_precio',
                                              'contador_inconsistente'))
  )
);
-- Lectura del SUM canónico por reserva (aplicar + reconstrucción).
CREATE INDEX IF NOT EXISTS invitados_extra_pagos_aplicados_idx
  ON invitados_extra_pagos (reserva_id) WHERE estado = 'aplicado';
-- Vista operativa del admin por estudio y fecha.
CREATE INDEX IF NOT EXISTS invitados_extra_pagos_tenant_fecha_idx
  ON invitados_extra_pagos (tenant_id, created_at DESC);

COMMENT ON TABLE invitados_extra_pagos IS
  'PKG-01H: un PaymentIntent de invitados extra → una fila con su resultado final (aplicado | no_aplicado). Inmutable.';

CREATE OR REPLACE FUNCTION invitados_extra_pagos_inmutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'EKKO_EXTRAS_INMUTABLE: La evidencia de un pago de invitados extra no se modifica ni se borra';
END;
$$;
REVOKE ALL ON FUNCTION invitados_extra_pagos_inmutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_invitados_extra_pagos_inmutable ON invitados_extra_pagos;
CREATE TRIGGER trg_invitados_extra_pagos_inmutable
  BEFORE UPDATE OR DELETE ON invitados_extra_pagos
  FOR EACH ROW EXECUTE FUNCTION invitados_extra_pagos_inmutable();

ALTER TABLE invitados_extra_pagos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invitados_extra_pagos_admin_read ON invitados_extra_pagos;
CREATE POLICY invitados_extra_pagos_admin_read ON invitados_extra_pagos
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());
-- Sin policy de escritura: solo aplicar_invitados_extra_pago (service_role).

-- ── 3. Revisión financiera: tipo nuevo (extensión aditiva de PKG-01G) ────────
-- Mismo conjunto de 01G + 'invitados_extra_no_aplicado'. Las filas existentes no
-- cambian; la semántica de reversals y resolver_revision_financiera no cambia.
ALTER TABLE revisiones_financieras
  DROP CONSTRAINT revisiones_financieras_tipo_check,
  ADD CONSTRAINT revisiones_financieras_tipo_check CHECK (tipo IN (
    'reembolso', 'disputa_abierta', 'disputa_perdida', 'origen_no_resuelto', 'origen_ambiguo',
    'reconciliacion_reembolso', 'cuenta_desautorizada', 'vinculo_valor_pendiente',
    'invitados_extra_no_aplicado'
  ));

-- ── 4. Aplicar un pago de invitados extra (una vez por PaymentIntent) ────────
-- Orden de locks (único en todo el código): advisory por PI → reserva FOR UPDATE.
--   · El advisory serializa dos workers del MISMO PI (+ UNIQUE como red).
--   · El FOR UPDATE de la reserva serializa PIs DISTINTOS de la misma reserva
--     (3 + 3 contra tope 4 → uno aplica, el otro excede_tope).
-- El resultado de un PI es FINAL: un no_aplicado no se vuelve aplicado por un
-- reintento, ni un aplicado deja de serlo por un reembolso (D7).
CREATE OR REPLACE FUNCTION aplicar_invitados_extra_pago(
  p_payment_intent_id text,
  p_stripe_account text,
  p_tenant_id uuid,
  p_stripe_event_id text,
  p_reserva_id uuid,
  p_usuario_id uuid,
  p_cantidad integer,
  p_monto_centavos integer,
  p_precio_unitario_centavos integer,
  p_moneda text,
  p_pagado_at timestamptz,
  p_tenant_id_metadata uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previo invitados_extra_pagos;
  v_reserva reservas;
  v_cuenta text;
  v_max integer;
  v_suma integer;
  v_motivo text;
  v_id uuid;
BEGIN
  IF p_payment_intent_id IS NULL OR p_tenant_id IS NULL OR p_stripe_account IS NULL
     OR p_cantidad IS NULL OR p_cantidad <= 0 OR p_monto_centavos IS NULL OR p_monto_centavos <= 0
     OR p_pagado_at IS NULL OR p_reserva_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_EXTRAS_DATOS: faltan datos del pago de invitados extra';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('extras:' || p_payment_intent_id, 0));

  -- Idempotencia de negocio: el PI ya tiene resultado final → se devuelve tal cual.
  SELECT * INTO v_previo FROM invitados_extra_pagos WHERE stripe_payment_intent_id = p_payment_intent_id;
  IF v_previo.id IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'estado', v_previo.estado,
                              'motivo', v_previo.motivo, 'pago_id', v_previo.id, 'revision_creada', false);
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;
  IF v_reserva.id IS NULL THEN
    -- Sin reserva no hay a qué atar evidencia: divergencia (revisión de 01A).
    RETURN jsonb_build_object('success', false, 'reason', 'reserva_no_encontrada');
  END IF;

  SELECT stripe_account_id INTO v_cuenta FROM tenants WHERE id = p_tenant_id;

  -- Validaciones en orden fijo (el primer motivo que aplica es el registrado).
  IF v_reserva.tenant_id <> p_tenant_id
     OR v_cuenta IS DISTINCT FROM p_stripe_account
     OR (p_tenant_id_metadata IS NOT NULL AND p_tenant_id_metadata <> p_tenant_id)
     OR p_usuario_id IS DISTINCT FROM v_reserva.usuario_id THEN
    v_motivo := 'tenant_incompatible';
  ELSIF v_reserva.status NOT IN ('confirmada', 'completada') THEN
    v_motivo := 'reserva_no_aplicable';
  ELSIF p_pagado_at >= v_reserva.slot_fin THEN
    v_motivo := 'reserva_pasada';
  ELSIF p_precio_unitario_centavos IS NULL THEN
    v_motivo := 'sin_snapshot_precio';
  ELSIF lower(COALESCE(p_moneda, '')) <> 'mxn'
        OR p_monto_centavos <> p_cantidad * p_precio_unitario_centavos THEN
    v_motivo := 'monto_no_coincide';
  ELSE
    SELECT COALESCE(SUM(cantidad), 0) INTO v_suma
    FROM invitados_extra_pagos WHERE reserva_id = v_reserva.id AND estado = 'aplicado';
    IF v_suma <> v_reserva.invitados_extra_pagados THEN
      v_motivo := 'contador_inconsistente';
    ELSE
      SELECT max_invitados_extra INTO v_max FROM recursos WHERE id = v_reserva.recurso_id;
      IF v_suma + p_cantidad > COALESCE(v_max, 0) THEN
        v_motivo := 'excede_tope';
      END IF;
    END IF;
  END IF;

  INSERT INTO invitados_extra_pagos (tenant_id, reserva_id, stripe_payment_intent_id, stripe_account, stripe_event_id,
                                     cantidad, monto_centavos, precio_unitario_centavos, moneda, estado, motivo, pagado_at)
  VALUES (p_tenant_id, v_reserva.id, p_payment_intent_id, p_stripe_account, p_stripe_event_id,
          p_cantidad, p_monto_centavos, p_precio_unitario_centavos, lower(COALESCE(p_moneda, 'mxn')),
          CASE WHEN v_motivo IS NULL THEN 'aplicado' ELSE 'no_aplicado' END, v_motivo, p_pagado_at)
  RETURNING id INTO v_id;

  IF v_motivo IS NULL THEN
    UPDATE reservas SET invitados_extra_pagados = invitados_extra_pagados + p_cantidad WHERE id = v_reserva.id;
    RETURN jsonb_build_object('success', true, 'idempotente', false, 'estado', 'aplicado', 'motivo', NULL,
                              'pago_id', v_id, 'invitados_extra_pagados', v_reserva.invitados_extra_pagados + p_cantidad,
                              'revision_creada', false);
  END IF;

  -- No aplicado: revisión financiera (una por PI; el PI ya no vuelve a llegar aquí).
  INSERT INTO revisiones_financieras (tenant_id, tipo, referencia, detalle)
  VALUES (p_tenant_id, 'invitados_extra_no_aplicado', p_payment_intent_id,
          jsonb_build_object('pago_id', v_id, 'reserva_id', v_reserva.id, 'stripe_payment_intent_id', p_payment_intent_id,
                             'cantidad', p_cantidad, 'monto_centavos', p_monto_centavos, 'moneda', lower(COALESCE(p_moneda, 'mxn')),
                             'motivo', v_motivo))
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('success', true, 'idempotente', false, 'estado', 'no_aplicado', 'motivo', v_motivo,
                            'pago_id', v_id, 'revision_creada', true);
END;
$$;
REVOKE ALL ON FUNCTION aplicar_invitados_extra_pago(text, text, uuid, text, uuid, uuid, integer, integer, integer, text, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION aplicar_invitados_extra_pago(text, text, uuid, text, uuid, uuid, integer, integer, integer, text, timestamptz, uuid)
  TO service_role;

-- La firma vieja (aditiva, sin llave) deja de ser ejecutable por cualquiera,
-- incluido service_role. No se borra (sin DROP en 099).
REVOKE ALL ON FUNCTION registrar_invitados_extra_pagados(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

-- ── 5. Fichas de invitados en recepción (W-3=A) ──────────────────────────────
-- Ventana de asistencia: la misma del check-in manual (slot_fin + 60 min).
CREATE OR REPLACE FUNCTION registrar_ficha_invitado(
  p_actor_id uuid,
  p_reserva_id uuid,
  p_nombre text,
  p_foto_path text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
  v_reserva reservas;
  v_n integer;
  v_cubiertos integer;
  v_es_extra boolean;
  v_id uuid;
BEGIN
  IF COALESCE(length(trim(p_nombre)), 0) < 2 THEN
    RAISE EXCEPTION 'EKKO_INVITADO_NOMBRE: El nombre del invitado es requerido';
  END IF;
  SELECT * INTO v_actor FROM usuarios WHERE id = p_actor_id;
  IF v_actor.id IS NULL OR v_actor.rol NOT IN ('admin', 'recepcionista') OR v_actor.status <> 'activo' THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden registrar invitados';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: Reserva no encontrada';
  END IF;
  IF v_reserva.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: Esa reserva es de otro estudio';
  END IF;
  IF v_reserva.status NOT IN ('confirmada', 'completada') THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_VIGENTE: La reserva no está vigente: no se registran invitados';
  END IF;
  IF now() >= v_reserva.slot_fin + interval '60 minutes' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_PASADA: La sesión ya terminó: no se registran invitados';
  END IF;

  SELECT COUNT(*) INTO v_n FROM reserva_invitados WHERE reserva_id = v_reserva.id;
  v_cubiertos := v_reserva.invitados_count + v_reserva.invitados_extra_pagados;
  IF v_n >= v_cubiertos THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_NO_CUBIERTOS: La reserva cubre % invitado(s) y ya están registrados', v_cubiertos;
  END IF;
  v_es_extra := (v_n + 1) > v_reserva.invitados_count;

  INSERT INTO reserva_invitados (tenant_id, reserva_id, nombre, foto_path, es_extra, created_by)
  VALUES (v_reserva.tenant_id, v_reserva.id, trim(p_nombre), p_foto_path, v_es_extra, v_actor.id)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'invitado_id', v_id, 'es_extra', v_es_extra,
                            'registrados', v_n + 1, 'cubiertos', v_cubiertos,
                            'incluidos', v_reserva.invitados_count, 'extras_pagados', v_reserva.invitados_extra_pagados);
END;
$$;
REVOKE ALL ON FUNCTION registrar_ficha_invitado(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION registrar_ficha_invitado(uuid, uuid, text, text) TO service_role;
