-- ============================================================================
-- PKG-01D · Evidencia financiera durable de las ventas de MOSTRADOR + snapshot
-- ============================================================================
-- Hasta hoy una venta de mostrador (efectivo, transferencia, terminal o
-- cortesía) activaba la membresía vía `activar_membresia` sin registrar NINGÚN
-- dinero: el único rastro era el texto libre `motivo` del audit_log, escrito
-- best-effort. Y el RPC de R1 solo es idempotente por suscripción de Stripe o
-- por `referencia_pago`; mostrador no mandaba ninguna, así que un reintento
-- (doble clic, timeout, refresh) creaba una segunda membresía que sumaba los
-- créditos otra vez o apilaba un mes (C15). Reportes calcula el MRR con el
-- precio ACTUAL del catálogo, así que la historia cambia cuando cambia el
-- precio (C22).
--
-- Invariantes que fija este paquete:
--   NINGÚN éxito financiero sin evidencia durable.
--   UNA venta lógica (operation_id) → MÁX 1 evidencia + MÁX 1 efecto de derecho.
--   La venta conserva el precio realmente aplicado aunque cambie el catálogo.
--
-- Diseño:
--   ventas_mostrador            evidencia + snapshot (precio de lista, monto
--                               cobrado, moneda, método, plan, actor).
--   registrar_venta_mostrador   primitiva server-owned, atómica e idempotente:
--                               CLAIM (lock por operation_id) → EXECUTE ONCE
--                               (evidencia + activar_membresia) → REPLAY (misma
--                               venta y membresía, idempotente=true). El binding
--                               de la operación (tenant, usuario, tier, método)
--                               se valida en el replay: el mismo id NO autoriza
--                               otra venta.
--
-- R1 NO cambia: `activar_membresia` se invoca tal cual con
-- `p_referencia = 'mostrador:<operation_id>'`, que su índice único
-- `membresias_referencia_pago_uniq` ya vuelve idempotente (segundo respaldo).
-- D9: efectivo/transferencia/terminal cobran el precio vigente; cortesía cobra 0
-- y conserva el precio de lista. D-01D-3: una suscripción de Stripe viva rechaza
-- la venta (no se cancela nada aquí).
--
-- Tests conductuales: src/__tests__/db/ventas-mostrador.db.test.ts
-- ============================================================================

CREATE TABLE IF NOT EXISTS ventas_mostrador (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Identidad de la venta lógica (UUID generado UNA vez por intención en el
  -- cliente). Global: un UUID no se repite entre tenants; el tenant se valida
  -- además como parte del binding en el replay.
  operation_id           uuid NOT NULL UNIQUE,
  usuario_id             uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  membresia_id           uuid REFERENCES membresias(id) ON DELETE SET NULL,
  tier_id                uuid NOT NULL REFERENCES tiers(id) ON DELETE RESTRICT,
  -- Snapshot del plan y del precio EN EL MOMENTO de la venta.
  tier_slug              text NOT NULL,
  tier_nombre            text NOT NULL,
  tier_tipo              text NOT NULL,
  precio_lista_centavos  integer NOT NULL CHECK (precio_lista_centavos >= 0),
  monto_cobrado_centavos integer NOT NULL CHECK (monto_cobrado_centavos >= 0),
  moneda                 text NOT NULL,
  metodo                 text NOT NULL CHECK (metodo IN ('efectivo', 'transferencia', 'terminal', 'cortesia')),
  -- Folio/referencia externa (transferencia, voucher). Nunca PII. Sin autoridad.
  referencia             text,
  -- Nota humana. NO es evidencia financiera.
  nota                   text,
  actor_usuario_id       uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  actor_rol              text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- D9: la cortesía cobra 0; cualquier otro método cobra el precio de lista.
  CONSTRAINT ventas_mostrador_monto_segun_metodo CHECK (
    (metodo = 'cortesia' AND monto_cobrado_centavos = 0)
    OR (metodo <> 'cortesia' AND monto_cobrado_centavos = precio_lista_centavos)
  )
);

COMMENT ON TABLE ventas_mostrador IS
  'PKG-01D · Evidencia financiera durable de cada venta de mostrador, con snapshot del precio aplicado. Una fila por operation_id.';
COMMENT ON COLUMN ventas_mostrador.operation_id IS
  'Identidad de la venta lógica (UUID del cliente, uno por intención). Llave de idempotencia de registrar_venta_mostrador.';
COMMENT ON COLUMN ventas_mostrador.nota IS 'Nota del staff. No es evidencia financiera ni autoridad.';

CREATE INDEX IF NOT EXISTS ventas_mostrador_tenant_fecha_idx ON ventas_mostrador (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ventas_mostrador_usuario_idx ON ventas_mostrador (usuario_id);
CREATE INDEX IF NOT EXISTS ventas_mostrador_membresia_idx ON ventas_mostrador (membresia_id);

-- RLS: como payment_events — solo el admin del tenant lee; escribe únicamente
-- service_role a través del RPC (sin policies de INSERT/UPDATE/DELETE).
ALTER TABLE ventas_mostrador ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ventas_mostrador_admin_read ON ventas_mostrador;
CREATE POLICY ventas_mostrador_admin_read ON ventas_mostrador
  FOR SELECT
  TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());

-- ----------------------------------------------------------------------------
-- registrar_venta_mostrador
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION registrar_venta_mostrador(
  p_operation_id uuid,
  p_actor_id uuid,
  p_usuario_id uuid,
  p_tier_id uuid,
  p_metodo text,
  p_referencia text DEFAULT NULL,
  p_nota text DEFAULT NULL,
  p_confirmar_perdida boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
  v_target usuarios;
  v_tier tiers;
  v_venta ventas_mostrador;
  v_precio integer;
  v_monto integer;
  v_activacion jsonb;
  v_membresia_id uuid;
  v_sub_viva text;
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_INVALIDA: operation_id requerido';
  END IF;
  IF p_metodo IS NULL OR p_metodo NOT IN ('efectivo', 'transferencia', 'terminal', 'cortesia') THEN
    RAISE EXCEPTION 'EKKO_METODO_INVALIDO: método de pago no reconocido';
  END IF;

  -- ── CLAIM ────────────────────────────────────────────────────────────────
  -- Lock transaccional por operation_id: dos requests concurrentes con el MISMO
  -- id se serializan aquí. La segunda espera a que la primera confirme o
  -- deshaga, y después decide con lo que quedó escrito: replay si la primera
  -- confirmó, ejecución fresca si se deshizo (no hubo ningún efecto).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 0));

  -- Actor: staff activo (rol y estado se leen aquí, nunca del cliente).
  SELECT * INTO v_actor FROM usuarios WHERE id = p_actor_id;
  IF v_actor.id IS NULL OR v_actor.rol NOT IN ('admin', 'recepcionista') OR v_actor.status <> 'activo' THEN
    RAISE EXCEPTION 'EKKO_ACTOR_NO_AUTORIZADO: Solo recepción o admin pueden registrar una venta';
  END IF;

  -- ── REPLAY ───────────────────────────────────────────────────────────────
  SELECT * INTO v_venta FROM ventas_mostrador WHERE operation_id = p_operation_id;
  IF v_venta.id IS NOT NULL THEN
    -- Binding: el mismo operation_id NO autoriza cambiar los parámetros de la venta.
    IF v_venta.tenant_id <> v_actor.tenant_id
       OR v_venta.usuario_id <> p_usuario_id
       OR v_venta.tier_id <> p_tier_id
       OR v_venta.metodo <> p_metodo THEN
      RAISE EXCEPTION 'EKKO_OPERACION_MOSTRADOR_CONFLICTO: El operation_id ya corresponde a otra venta';
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'idempotente', true,
      'venta_id', v_venta.id,
      'membresia_id', v_venta.membresia_id,
      'tier', v_venta.tier_slug,
      'metodo', v_venta.metodo,
      'precio_lista_centavos', v_venta.precio_lista_centavos,
      'monto_cobrado_centavos', v_venta.monto_cobrado_centavos,
      'moneda', v_venta.moneda
    );
  END IF;

  -- ── EXECUTE ONCE ─────────────────────────────────────────────────────────
  SELECT * INTO v_target FROM usuarios WHERE id = p_usuario_id;
  IF v_target.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_USUARIO_NO_EXISTE: Miembro no encontrado';
  END IF;
  IF v_target.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DISTINTO: El miembro pertenece a otro estudio';
  END IF;
  -- Solo un admin opera sobre cuentas del equipo (misma regla que puedeOperarSobre).
  IF v_target.rol <> 'miembro' AND v_actor.rol <> 'admin' THEN
    RAISE EXCEPTION 'EKKO_ACTOR_NO_AUTORIZADO: Solo un admin puede modificar las cuentas del equipo';
  END IF;

  SELECT * INTO v_tier
  FROM tiers
  WHERE id = p_tier_id AND tenant_id = v_actor.tenant_id AND activo = true;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_TIER_INVALIDO: Plan no encontrado o inactivo';
  END IF;

  -- D-01D-3: una suscripción de Stripe viva seguiría cobrando; mostrador no la
  -- sustituye en silencio ni la cancela. Se resuelve primero por su flujo.
  SELECT stripe_subscription_id INTO v_sub_viva
  FROM membresias
  WHERE usuario_id = p_usuario_id
    AND status IN ('trialing', 'activa', 'past_due', 'pausada')
    AND stripe_subscription_id IS NOT NULL
  LIMIT 1;
  IF v_sub_viva IS NOT NULL THEN
    RAISE EXCEPTION 'EKKO_TIENE_SUSCRIPCION_STRIPE: El miembro tiene una suscripción de Stripe vigente; cancélala primero';
  END IF;

  -- Precio y monto: derivados del catálogo AQUÍ (el cliente no manda importes).
  v_precio := v_tier.precio_centavos;
  v_monto := CASE WHEN p_metodo = 'cortesia' THEN 0 ELSE v_precio END;

  -- Evidencia durable dentro de la misma transacción que el derecho: si la
  -- activación lanza, esta fila se deshace con ella.
  INSERT INTO ventas_mostrador (
    tenant_id, operation_id, usuario_id, tier_id,
    tier_slug, tier_nombre, tier_tipo,
    precio_lista_centavos, monto_cobrado_centavos, moneda, metodo,
    referencia, nota, actor_usuario_id, actor_rol
  ) VALUES (
    v_actor.tenant_id, p_operation_id, p_usuario_id, p_tier_id,
    v_tier.slug, v_tier.nombre, v_tier.tipo,
    v_precio, v_monto, v_tier.moneda, p_metodo,
    NULLIF(btrim(p_referencia), ''), NULLIF(btrim(p_nota), ''), v_actor.id, v_actor.rol
  )
  RETURNING * INTO v_venta;

  -- Exactamente UNA activación lógica, por el RPC de R1 sin cambios. La
  -- referencia con prefijo es única en membresias: segundo respaldo de idempotencia.
  v_activacion := activar_membresia(
    p_usuario_id,
    p_tier_id,
    NULL,
    NULL,
    NULL,
    'mostrador:' || p_operation_id::text,
    COALESCE(p_confirmar_perdida, false)
  );
  v_membresia_id := (v_activacion->>'membresia_id')::uuid;

  UPDATE ventas_mostrador SET membresia_id = v_membresia_id WHERE id = v_venta.id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotente', false,
    'venta_id', v_venta.id,
    'membresia_id', v_membresia_id,
    'tier', v_tier.slug,
    'metodo', p_metodo,
    'precio_lista_centavos', v_precio,
    'monto_cobrado_centavos', v_monto,
    'moneda', v_tier.moneda,
    'activacion', v_activacion
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION registrar_venta_mostrador(uuid, uuid, uuid, uuid, text, text, text, boolean)
  FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION registrar_venta_mostrador(uuid, uuid, uuid, uuid, text, text, text, boolean)
  TO service_role;
