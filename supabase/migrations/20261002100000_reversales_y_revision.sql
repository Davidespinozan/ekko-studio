-- ============================================================================
-- PKG-01G · REEMBOLSOS / DISPUTAS / DESAUTORIZACIÓN DE CONNECT (C18, D7, D8)
-- ----------------------------------------------------------------------------
-- Decisiones del owner (D7=A, D8=A, D-01G-3, D-01G-4):
--   · Un reembolso o una disputa NUNCA muta derechos por sí sola: ni créditos,
--     ni membresía, ni cuenta, ni tier, ni reservas, ni suscripción en Stripe.
--   · Deja EVIDENCIA durable con identidad propia (el objeto de Stripe: re_… /
--     dp_…), atribuida a su pago de origen solo cuando se puede demostrar, y
--     abre una REVISIÓN humana durable. El admin documenta; no "arregla" aquí.
--   · La desautorización de Connect apaga la capacidad de cobro del estudio y
--     conserva `stripe_account_id` (trazabilidad). No toca membresías.
--   · Proveniencia del valor hacia adelante en `membresia_movimientos`; lo
--     histórico queda explícitamente 'desconocido' (sin backfill inventado).
--
-- Invariantes:
--   REVERSAL OF PAYMENT X MUST NOT MUTATE ENTITLEMENT Y UNLESS X PROVABLY FUNDED Y.
--   AMBIGUOUS FINANCIAL REVERSAL → DURABLE REVIEW, NOT GUESSED ENTITLEMENT MUTATION.
--   EVERY STRIPE REVERSAL MUST LEAVE DURABLE, IDENTITY-KEYED, IDEMPOTENT FINANCIAL EVIDENCE.
--   REFUND ≠ SUBSCRIPTION CANCELLATION.
--   CONNECT ACCOUNT LIFECYCLE AFFECTS THE STUDIO'S ABILITY TO CHARGE, NEVER A MEMBER'S ENTITLEMENT.
--
-- Aditiva: sin DROP, sin UPDATE/backfill de datos. No toca activar_membresia,
-- sync_membresia_stripe, cambiar_tier_membresia, registrar_venta_mostrador ni
-- claim_stripe_event. Lo único que se amplía es el trigger de inmutabilidad del
-- ledger para un write-once (origen_payment_event_id de NULL a valor).
-- ============================================================================

-- ── 1. reversales_pago: una fila por objeto Refund / Dispute de Stripe ───────
-- Identidad, dinero y origen son INMUTABLES; solo cambia el estado del proveedor,
-- y únicamente con eventos más nuevos (guardia de orden, como last_sub_event_at).
CREATE TABLE IF NOT EXISTS reversales_pago (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  tipo                      text NOT NULL CHECK (tipo IN ('reembolso', 'disputa')),
  stripe_object_id          text NOT NULL UNIQUE,            -- re_… | dp_…
  stripe_charge_id          text NOT NULL,
  stripe_payment_intent_id  text,
  stripe_account            text,
  pago_origen_id            uuid REFERENCES payment_events(id) ON DELETE SET NULL,
  membresia_origen_id       uuid REFERENCES membresias(id) ON DELETE SET NULL,
  usuario_id                uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  monto_centavos            integer NOT NULL CHECK (monto_centavos > 0), -- EXACTO del objeto, nunca acumulado
  moneda                    text NOT NULL,
  estado_proveedor          text NOT NULL,
  motivo_proveedor          text,
  stripe_created_at         timestamptz,
  ultimo_evento_at          timestamptz NOT NULL,
  ultimo_stripe_event_id    text NOT NULL,
  resumen                   jsonb NOT NULL DEFAULT '{}'::jsonb,            -- ids y montos; sin PII
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reversales_pago_objeto_tipo_check CHECK (
    (tipo = 'reembolso' AND stripe_object_id LIKE 're\_%')
    OR (tipo = 'disputa' AND stripe_object_id LIKE 'dp\_%')
  ),
  CONSTRAINT reversales_pago_estado_check CHECK (
    (tipo = 'reembolso' AND estado_proveedor IN ('pending', 'succeeded', 'failed', 'canceled', 'requires_action'))
    OR (tipo = 'disputa' AND estado_proveedor IN ('warning_needs_response', 'warning_under_review', 'warning_closed',
                                                  'needs_response', 'under_review', 'won', 'lost', 'charge_refunded'))
  )
);
CREATE INDEX IF NOT EXISTS reversales_pago_charge_idx ON reversales_pago (stripe_charge_id);
CREATE INDEX IF NOT EXISTS reversales_pago_tenant_fecha_idx ON reversales_pago (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reversales_pago_pi_idx ON reversales_pago (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reversales_pago_sin_origen_idx ON reversales_pago (tenant_id) WHERE pago_origen_id IS NULL;

COMMENT ON TABLE reversales_pago IS
  'PKG-01G: evidencia durable de reembolsos (re_) y disputas (dp_) de Stripe, una fila por objeto. No muta derechos.';
COMMENT ON COLUMN reversales_pago.monto_centavos IS
  'Monto EXACTO del objeto Refund/Dispute. Nunca charge.amount_refunded (acumulado).';
COMMENT ON COLUMN reversales_pago.pago_origen_id IS
  'payment_events que financió el cargo, solo si se demostró sin ambigüedad. NULL = origen no resuelto (revisión).';

CREATE OR REPLACE FUNCTION reversales_pago_inmutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'EKKO_REVERSAL_INMUTABLE: La evidencia de un reembolso/disputa no se borra';
  END IF;
  IF NEW.tipo <> OLD.tipo OR NEW.stripe_object_id <> OLD.stripe_object_id
     OR NEW.stripe_charge_id <> OLD.stripe_charge_id OR NEW.monto_centavos <> OLD.monto_centavos
     OR NEW.moneda <> OLD.moneda OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.stripe_created_at IS DISTINCT FROM OLD.stripe_created_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'EKKO_REVERSAL_INMUTABLE: identidad, monto y tenant de un reversal no cambian';
  END IF;
  -- El origen solo se fija una vez (write-once): de NULL a valor.
  IF OLD.pago_origen_id IS NOT NULL AND NEW.pago_origen_id IS DISTINCT FROM OLD.pago_origen_id THEN
    RAISE EXCEPTION 'EKKO_REVERSAL_INMUTABLE: el pago de origen no se reasigna';
  END IF;
  -- El estado del proveedor solo avanza con eventos más nuevos.
  IF NEW.ultimo_evento_at < OLD.ultimo_evento_at THEN
    RAISE EXCEPTION 'EKKO_REVERSAL_ORDEN: evento más viejo que el último aplicado';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION reversales_pago_inmutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_reversales_pago_inmutable ON reversales_pago;
CREATE TRIGGER trg_reversales_pago_inmutable
  BEFORE UPDATE OR DELETE ON reversales_pago
  FOR EACH ROW EXECUTE FUNCTION reversales_pago_inmutable();

ALTER TABLE reversales_pago ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reversales_pago_admin_read ON reversales_pago;
CREATE POLICY reversales_pago_admin_read ON reversales_pago
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());
-- Sin policy de escritura: solo service_role (webhook) escribe.

-- ── 2. revisiones_financieras: estado de trabajo humano, separado de la evidencia
CREATE TABLE IF NOT EXISTS revisiones_financieras (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  reversal_id              uuid REFERENCES reversales_pago(id) ON DELETE RESTRICT,
  tipo                     text NOT NULL CHECK (tipo IN ('reembolso', 'disputa_abierta', 'disputa_perdida',
                                                         'origen_no_resuelto', 'origen_ambiguo',
                                                         'reconciliacion_reembolso', 'cuenta_desautorizada',
                                                         'vinculo_valor_pendiente')),
  referencia               text,                             -- charge id / cuenta / membresía para revisiones sin reversal
  estado                   text NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'resuelta')),
  resolucion               text CHECK (resolucion IS NULL OR resolucion IN ('sin_efecto', 'disputa_ganada', 'reconciliado',
                                                                            'ajuste_manual_registrado', 'otro')),
  nota                     text,
  detalle                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_usuario_id         uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  actor_rol                text,
  abierta_at               timestamptz NOT NULL DEFAULT now(),
  resuelta_at              timestamptz,
  reabierta_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revisiones_financieras_resuelta_check CHECK (
    (estado = 'abierta' AND resolucion IS NULL AND resuelta_at IS NULL)
    OR (estado = 'resuelta' AND resolucion IS NOT NULL AND resuelta_at IS NOT NULL)
  ),
  CONSTRAINT revisiones_financieras_sujeto_check CHECK (reversal_id IS NOT NULL OR referencia IS NOT NULL)
);
-- Una revisión por reversal: eventos duplicados no duplican revisiones.
CREATE UNIQUE INDEX IF NOT EXISTS revisiones_financieras_reversal_uniq
  ON revisiones_financieras (reversal_id) WHERE reversal_id IS NOT NULL;
-- Una revisión ABIERTA por (tenant, tipo, referencia) para las que no tienen reversal.
CREATE UNIQUE INDEX IF NOT EXISTS revisiones_financieras_referencia_abierta_uniq
  ON revisiones_financieras (tenant_id, tipo, referencia) WHERE reversal_id IS NULL AND estado = 'abierta';
CREATE INDEX IF NOT EXISTS revisiones_financieras_abiertas_idx
  ON revisiones_financieras (tenant_id, abierta_at DESC) WHERE estado = 'abierta';

COMMENT ON TABLE revisiones_financieras IS
  'PKG-01G: revisión humana durable de reversals financieros. Documenta; no muta derechos.';

ALTER TABLE revisiones_financieras ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS revisiones_financieras_admin_read ON revisiones_financieras;
CREATE POLICY revisiones_financieras_admin_read ON revisiones_financieras
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());
-- Escritura humana solo vía resolver_revision_financiera (SECURITY DEFINER).

-- ── 3. Connect: estado explícito de desconexión (se conserva stripe_account_id)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_desconectado_at timestamptz;
COMMENT ON COLUMN tenants.stripe_desconectado_at IS
  'PKG-01G: account.application.deauthorized. Con valor, el estudio no puede cobrar aunque conserve stripe_account_id.';
-- Privada como el resto de stripe_*: los GRANT de tenants son por columna
-- (20260821150000), así que una columna nueva nace sin SELECT para anon /
-- authenticated. Se verifica para que no dependa de ese detalle.
DO $$
BEGIN
  IF has_column_privilege('anon', 'tenants', 'stripe_desconectado_at', 'SELECT')
     OR has_column_privilege('authenticated', 'tenants', 'stripe_desconectado_at', 'SELECT')
     OR has_column_privilege('authenticated', 'tenants', 'stripe_desconectado_at', 'UPDATE') THEN
    RAISE EXCEPTION 'tenants.stripe_desconectado_at no debe ser legible ni editable por anon/authenticated';
  END IF;
END $$;

-- ── 4. Proveniencia del valor (hacia adelante) ───────────────────────────────
ALTER TABLE membresia_movimientos
  ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'desconocido'
    CHECK (origen IN ('compra_stripe', 'suscripcion_stripe', 'venta_mostrador', 'cortesia',
                      'traslado', 'cierre_sistema', 'ajuste_staff', 'reserva', 'desconocido')),
  ADD COLUMN IF NOT EXISTS origen_payment_event_id uuid REFERENCES payment_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS origen_venta_id uuid REFERENCES ventas_mostrador(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS membresia_movimientos_origen_pe_idx
  ON membresia_movimientos (origen_payment_event_id) WHERE origen_payment_event_id IS NOT NULL;
COMMENT ON COLUMN membresia_movimientos.origen IS
  'PKG-01G: de dónde viene el movimiento. ''desconocido'' = anterior a 01G (sin backfill).';

-- Clasificación DETERMINISTA al insertar, por datos (no por texto del motivo):
--   debito/devolucion/no_show → reserva.
--   alta → por membresias.referencia_pago: 'mostrador:<op>' → ventas_mostrador
--          (cortesía si metodo='cortesia'); 'pi_…' → compra_stripe; sin
--          referencia y con suscripción → suscripcion_stripe.
--   ajuste → con actor autenticado (staff RPC) → ajuste_staff; sin actor
--            (service_role: activar_membresia, expirar) → delta>0 traslado,
--            si no cierre_sistema.
-- No toca ninguna función existente: las filas se clasifican al nacer.
CREATE OR REPLACE FUNCTION movimientos_origen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ref text;
  v_sub text;
  v_venta ventas_mostrador;
BEGIN
  IF NEW.origen IS DISTINCT FROM 'desconocido' THEN
    RETURN NEW; -- ya clasificado por quien inserta
  END IF;
  IF NEW.tipo IN ('debito', 'devolucion', 'no_show') THEN
    NEW.origen := 'reserva';
    RETURN NEW;
  END IF;
  IF NEW.tipo = 'alta' THEN
    SELECT referencia_pago, stripe_subscription_id INTO v_ref, v_sub FROM membresias WHERE id = NEW.membresia_id;
    IF v_ref LIKE 'mostrador:%' THEN
      SELECT * INTO v_venta FROM ventas_mostrador
      WHERE operation_id::text = substr(v_ref, length('mostrador:') + 1) LIMIT 1;
      IF v_venta.id IS NOT NULL THEN
        NEW.origen := CASE WHEN v_venta.metodo = 'cortesia' THEN 'cortesia' ELSE 'venta_mostrador' END;
        NEW.origen_venta_id := v_venta.id;
      ELSE
        NEW.origen := 'venta_mostrador';
      END IF;
    ELSIF v_ref IS NOT NULL THEN
      NEW.origen := 'compra_stripe';
    ELSIF v_sub IS NOT NULL THEN
      NEW.origen := 'suscripcion_stripe';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tipo = 'ajuste' THEN
    IF get_my_user_id() IS NOT NULL THEN
      NEW.origen := 'ajuste_staff';
    ELSIF NEW.delta > 0 THEN
      NEW.origen := 'traslado';
    ELSE
      NEW.origen := 'cierre_sistema';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION movimientos_origen() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_movimientos_origen ON membresia_movimientos;
CREATE TRIGGER trg_movimientos_origen
  BEFORE INSERT ON membresia_movimientos
  FOR EACH ROW EXECUTE FUNCTION movimientos_origen();

-- Ledger inmutable: se añade UN write-once permitido: origen_payment_event_id de
-- NULL a valor (la 'alta' nace antes de que exista el payment_event). Todo lo
-- demás sigue igual que en 20260921100000.
CREATE OR REPLACE FUNCTION ledger_inmutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- La misma función protege audit_log (trg_audit_inmutable): ni UPDATE ni DELETE, nunca.
  IF TG_TABLE_NAME = 'audit_log' THEN
    RAISE EXCEPTION 'EKKO_LEDGER_INMUTABLE: La bitácora no se modifica ni se borra';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id = OLD.id AND NEW.tenant_id = OLD.tenant_id AND NEW.membresia_id = OLD.membresia_id
       AND NEW.usuario_id = OLD.usuario_id AND NEW.tipo = OLD.tipo AND NEW.delta = OLD.delta
       AND NEW.saldo_after IS NOT DISTINCT FROM OLD.saldo_after AND NEW.motivo IS NOT DISTINCT FROM OLD.motivo
       AND NEW.created_at = OLD.created_at
       AND NEW.origen = OLD.origen
       AND NEW.origen_venta_id IS NOT DISTINCT FROM OLD.origen_venta_id THEN
      -- ON DELETE SET NULL de reservas
      IF NEW.reserva_id IS NULL AND OLD.reserva_id IS NOT NULL
         AND NEW.origen_payment_event_id IS NOT DISTINCT FROM OLD.origen_payment_event_id THEN
        RETURN NEW;
      END IF;
      -- PKG-01G write-once: vincular el pago de origen (solo de NULL a valor)
      IF NEW.reserva_id IS NOT DISTINCT FROM OLD.reserva_id
         AND OLD.origen_payment_event_id IS NULL AND NEW.origen_payment_event_id IS NOT NULL THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'EKKO_LEDGER_INMUTABLE: Un movimiento de créditos no se modifica; registra un ajuste';
  END IF;
  -- DELETE: solo el CASCADE (la membresía padre ya no existe).
  IF EXISTS (SELECT 1 FROM membresias WHERE id = OLD.membresia_id) THEN
    RAISE EXCEPTION 'EKKO_LEDGER_INMUTABLE: Un movimiento de créditos no se borra';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION ledger_inmutable() FROM PUBLIC, anon, authenticated;

-- Vista: valor por lote de origen, por membresía (lo histórico queda 'desconocido').
CREATE OR REPLACE VIEW valor_por_lote AS
  SELECT membresia_id, tenant_id, usuario_id, origen,
         SUM(delta) FILTER (WHERE delta > 0) AS otorgado,
         SUM(-delta) FILTER (WHERE delta < 0) AS retirado,
         COUNT(*) AS movimientos,
         MIN(created_at) AS primero_at,
         MAX(created_at) AS ultimo_at
  FROM membresia_movimientos
  GROUP BY membresia_id, tenant_id, usuario_id, origen;
GRANT SELECT ON valor_por_lote TO authenticated, service_role;

-- ── 5. RPC: registrar un reversal (idempotente por objeto, ordenado por evento)
-- Atribución del origen (HARDENING A): candidatos = payment_events 'succeeded'
-- del mismo PaymentIntent. Exactamente una combinación (tenant, usuario,
-- membresía) → se enlaza; ninguna → 'origen_no_resuelto'; varias incompatibles
-- → 'origen_ambiguo'. Nunca se adivina.
CREATE OR REPLACE FUNCTION registrar_reversal_pago(
  p_tipo text,
  p_stripe_object_id text,
  p_stripe_charge_id text,
  p_stripe_payment_intent_id text,
  p_stripe_account text,
  p_tenant_id uuid,
  p_monto_centavos integer,
  p_moneda text,
  p_estado_proveedor text,
  p_motivo_proveedor text,
  p_stripe_created_at timestamptz,
  p_evento_at timestamptz,
  p_stripe_event_id text,
  p_resumen jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existente reversales_pago;
  v_candidatos integer := 0;
  v_pago_id uuid;
  v_usuario uuid;
  v_membresia uuid;
  v_tenant uuid := p_tenant_id;
  v_id uuid;
  v_nuevo boolean := false;
  v_origen text;
  v_tipo_revision text;
  v_rev_id uuid;
  v_estado_prev text;
BEGIN
  IF p_tipo NOT IN ('reembolso', 'disputa') THEN
    RAISE EXCEPTION 'EKKO_REVERSAL_TIPO: tipo inválido %', p_tipo;
  END IF;
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_REVERSAL_SIN_TENANT: un reversal sin estudio no se registra';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('reversal:' || p_stripe_object_id, 0));

  SELECT * INTO v_existente FROM reversales_pago WHERE stripe_object_id = p_stripe_object_id FOR UPDATE;

  IF v_existente.id IS NULL THEN
    -- Origen: candidatos del mismo PaymentIntent.
    IF p_stripe_payment_intent_id IS NOT NULL THEN
      SELECT COUNT(*) INTO v_candidatos FROM (
        SELECT DISTINCT tenant_id, usuario_id, membresia_id
        FROM payment_events
        WHERE stripe_payment_intent_id = p_stripe_payment_intent_id AND status = 'succeeded'
      ) c;
      IF v_candidatos = 1 THEN
        SELECT id, usuario_id, membresia_id, tenant_id INTO v_pago_id, v_usuario, v_membresia, v_tenant
        FROM payment_events
        WHERE stripe_payment_intent_id = p_stripe_payment_intent_id AND status = 'succeeded'
        ORDER BY created_at ASC LIMIT 1;
        v_tenant := COALESCE(v_tenant, p_tenant_id);
        IF v_tenant <> p_tenant_id THEN
          -- El pago pertenece a otro estudio que la cuenta del evento: no se enlaza.
          v_pago_id := NULL; v_usuario := NULL; v_membresia := NULL; v_tenant := p_tenant_id;
          v_origen := 'ambiguo';
        ELSE
          v_origen := 'unico';
        END IF;
      ELSIF v_candidatos = 0 THEN
        v_origen := 'ninguno';
      ELSE
        v_origen := 'ambiguo';
      END IF;
    ELSE
      v_origen := 'ninguno';
    END IF;

    INSERT INTO reversales_pago (tenant_id, tipo, stripe_object_id, stripe_charge_id, stripe_payment_intent_id, stripe_account,
                                 pago_origen_id, membresia_origen_id, usuario_id, monto_centavos, moneda,
                                 estado_proveedor, motivo_proveedor, stripe_created_at, ultimo_evento_at, ultimo_stripe_event_id, resumen)
    VALUES (v_tenant, p_tipo, p_stripe_object_id, p_stripe_charge_id, p_stripe_payment_intent_id, p_stripe_account,
            v_pago_id, v_membresia, v_usuario, p_monto_centavos, p_moneda,
            p_estado_proveedor, p_motivo_proveedor, p_stripe_created_at, p_evento_at, p_stripe_event_id, COALESCE(p_resumen, '{}'::jsonb))
    RETURNING id INTO v_id;
    v_nuevo := true;

    -- Revisión durable (una por reversal).
    v_tipo_revision := CASE
      WHEN p_tipo = 'disputa' AND p_estado_proveedor = 'lost' THEN 'disputa_perdida'
      WHEN p_tipo = 'disputa' THEN 'disputa_abierta'
      ELSE 'reembolso'
    END;
    INSERT INTO revisiones_financieras (tenant_id, reversal_id, tipo, detalle)
    VALUES (v_tenant, v_id, v_tipo_revision,
            jsonb_build_object('origen', v_origen, 'stripe_object_id', p_stripe_object_id,
                               'stripe_charge_id', p_stripe_charge_id, 'monto_centavos', p_monto_centavos))
    RETURNING id INTO v_rev_id;
    -- Disputa ganada de entrada (raro: evento closed sin created): cerrada por el sistema.
    IF p_tipo = 'disputa' AND p_estado_proveedor IN ('won', 'warning_closed') THEN
      UPDATE revisiones_financieras SET estado = 'resuelta', resolucion = 'disputa_ganada', resuelta_at = now(),
             actor_rol = 'sistema', updated_at = now() WHERE id = v_rev_id;
    END IF;
    -- Origen no resuelto / ambiguo: revisión aparte, referenciada por el objeto.
    IF v_origen IN ('ninguno', 'ambiguo') THEN
      INSERT INTO revisiones_financieras (tenant_id, tipo, referencia, detalle)
      VALUES (v_tenant, CASE WHEN v_origen = 'ninguno' THEN 'origen_no_resuelto' ELSE 'origen_ambiguo' END,
              p_stripe_object_id,
              jsonb_build_object('stripe_payment_intent_id', p_stripe_payment_intent_id, 'candidatos', v_candidatos))
      ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    -- Ya existe: solo avanza el estado del proveedor con eventos más nuevos.
    IF v_existente.ultimo_stripe_event_id = p_stripe_event_id OR p_evento_at < v_existente.ultimo_evento_at THEN
      RETURN jsonb_build_object('success', true, 'reversal_id', v_existente.id, 'idempotente', true,
                                'estado_proveedor', v_existente.estado_proveedor, 'nuevo', false);
    END IF;
    IF v_existente.monto_centavos <> p_monto_centavos OR v_existente.stripe_charge_id <> p_stripe_charge_id THEN
      RAISE EXCEPTION 'EKKO_REVERSAL_CONFLICTO: el objeto % llegó con monto/cargo distinto', p_stripe_object_id;
    END IF;
    v_estado_prev := v_existente.estado_proveedor;
    UPDATE reversales_pago
    SET estado_proveedor = p_estado_proveedor, motivo_proveedor = COALESCE(p_motivo_proveedor, motivo_proveedor),
        ultimo_evento_at = p_evento_at, ultimo_stripe_event_id = p_stripe_event_id,
        resumen = COALESCE(p_resumen, resumen)
    WHERE id = v_existente.id;
    v_id := v_existente.id;
    v_tenant := v_existente.tenant_id;
    -- Disputa: ganada → cerrar la revisión; perdida → mantener/reabrir bajo D7.
    IF p_tipo = 'disputa' THEN
      IF p_estado_proveedor IN ('won', 'warning_closed') THEN
        UPDATE revisiones_financieras SET estado = 'resuelta', resolucion = 'disputa_ganada', resuelta_at = now(),
               actor_rol = 'sistema', actor_usuario_id = NULL, nota = COALESCE(nota, 'Disputa ganada según Stripe'), updated_at = now()
        WHERE reversal_id = v_id AND estado = 'abierta';
      ELSIF p_estado_proveedor = 'lost' THEN
        UPDATE revisiones_financieras SET tipo = 'disputa_perdida', updated_at = now()
        WHERE reversal_id = v_id AND estado = 'abierta';
        UPDATE revisiones_financieras SET estado = 'abierta', tipo = 'disputa_perdida', resolucion = NULL, resuelta_at = NULL,
               reabierta_at = now(), updated_at = now()
        WHERE reversal_id = v_id AND estado = 'resuelta' AND resolucion = 'disputa_ganada';
      END IF;
    END IF;
  END IF;

  -- Reconciliación: si había una revisión de charge.refunded esperando este monto, cerrarla.
  IF p_tipo = 'reembolso' THEN
    PERFORM cerrar_reconciliacion_si_cuadra(v_tenant, p_stripe_charge_id);
  END IF;

  RETURN jsonb_build_object('success', true, 'reversal_id', v_id, 'nuevo', v_nuevo, 'origen', COALESCE(v_origen, 'existente'),
                            'pago_origen_id', COALESCE(v_pago_id, v_existente.pago_origen_id),
                            'membresia_origen_id', COALESCE(v_membresia, v_existente.membresia_origen_id),
                            'usuario_id', COALESCE(v_usuario, v_existente.usuario_id),
                            'estado_proveedor', p_estado_proveedor);
END;
$$;
REVOKE ALL ON FUNCTION registrar_reversal_pago(text, text, text, text, text, uuid, integer, text, text, text, timestamptz, timestamptz, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION registrar_reversal_pago(text, text, text, text, text, uuid, integer, text, text, text, timestamptz, timestamptz, text, jsonb)
  TO service_role;

-- ── 6. RPC: reconciliación con charge.refunded (acumulado) ───────────────────
-- charge.refunded NO es evidencia de monto: solo se compara su amount_refunded
-- con la suma de los Refund 'succeeded' del mismo cargo. Si no cuadra (eventos
-- refund.* aún no llegan / no suscritos) → revisión 'reconciliacion_reembolso'
-- con el monto esperado; se cierra sola cuando cuadra.
CREATE OR REPLACE FUNCTION reconciliar_reembolsos_cargo(
  p_tenant_id uuid,
  p_stripe_charge_id text,
  p_amount_refunded integer,
  p_stripe_event_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_suma integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('reconciliacion:' || p_stripe_charge_id, 0));
  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_suma
  FROM reversales_pago WHERE tipo = 'reembolso' AND stripe_charge_id = p_stripe_charge_id AND estado_proveedor = 'succeeded';
  IF v_suma = p_amount_refunded THEN
    UPDATE revisiones_financieras SET estado = 'resuelta', resolucion = 'reconciliado', resuelta_at = now(), actor_rol = 'sistema', updated_at = now()
    WHERE tenant_id = p_tenant_id AND tipo = 'reconciliacion_reembolso' AND referencia = p_stripe_charge_id AND estado = 'abierta';
    RETURN jsonb_build_object('success', true, 'cuadra', true, 'suma_centavos', v_suma);
  END IF;
  INSERT INTO revisiones_financieras (tenant_id, tipo, referencia, detalle)
  VALUES (p_tenant_id, 'reconciliacion_reembolso', p_stripe_charge_id,
          jsonb_build_object('amount_refunded', p_amount_refunded, 'suma_reembolsos', v_suma, 'stripe_event_id', p_stripe_event_id))
  ON CONFLICT (tenant_id, tipo, referencia) WHERE reversal_id IS NULL AND estado = 'abierta'
  DO UPDATE SET detalle = EXCLUDED.detalle, updated_at = now();
  RETURN jsonb_build_object('success', true, 'cuadra', false, 'suma_centavos', v_suma, 'esperado_centavos', p_amount_refunded);
END;
$$;
REVOKE ALL ON FUNCTION reconciliar_reembolsos_cargo(uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reconciliar_reembolsos_cargo(uuid, text, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION cerrar_reconciliacion_si_cuadra(p_tenant_id uuid, p_stripe_charge_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rev revisiones_financieras;
  v_suma integer;
BEGIN
  SELECT * INTO v_rev FROM revisiones_financieras
  WHERE tenant_id = p_tenant_id AND tipo = 'reconciliacion_reembolso' AND referencia = p_stripe_charge_id AND estado = 'abierta'
  LIMIT 1;
  IF v_rev.id IS NULL THEN RETURN; END IF;
  SELECT COALESCE(SUM(monto_centavos), 0) INTO v_suma
  FROM reversales_pago WHERE tipo = 'reembolso' AND stripe_charge_id = p_stripe_charge_id AND estado_proveedor = 'succeeded';
  IF v_suma = (v_rev.detalle->>'amount_refunded')::integer THEN
    UPDATE revisiones_financieras SET estado = 'resuelta', resolucion = 'reconciliado', resuelta_at = now(), actor_rol = 'sistema', updated_at = now()
    WHERE id = v_rev.id;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION cerrar_reconciliacion_si_cuadra(uuid, text) FROM PUBLIC, anon, authenticated;

-- ── 7. RPC: re-atribuir reversals cuando llega tarde el pago exitoso ─────────
-- (HARDENING B) Se llama dentro del paso verificado del webhook (antes de
-- 'procesado'): si falla, el evento se reintenta. Y aunque nunca se llamara, la
-- fila sin origen y su revisión 'origen_no_resuelto' quedan consultables.
CREATE OR REPLACE FUNCTION reatribuir_reversales(p_stripe_payment_intent_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidatos integer;
  v_pago_id uuid; v_usuario uuid; v_membresia uuid; v_tenant uuid;
  v_n integer := 0;
BEGIN
  IF p_stripe_payment_intent_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'reatribuidos', 0);
  END IF;
  SELECT COUNT(*) INTO v_candidatos FROM (
    SELECT DISTINCT tenant_id, usuario_id, membresia_id FROM payment_events
    WHERE stripe_payment_intent_id = p_stripe_payment_intent_id AND status = 'succeeded'
  ) c;
  IF v_candidatos <> 1 THEN
    RETURN jsonb_build_object('success', true, 'reatribuidos', 0, 'candidatos', v_candidatos);
  END IF;
  SELECT id, usuario_id, membresia_id, tenant_id INTO v_pago_id, v_usuario, v_membresia, v_tenant
  FROM payment_events WHERE stripe_payment_intent_id = p_stripe_payment_intent_id AND status = 'succeeded'
  ORDER BY created_at ASC LIMIT 1;
  UPDATE reversales_pago
  SET pago_origen_id = v_pago_id, membresia_origen_id = COALESCE(membresia_origen_id, v_membresia),
      usuario_id = COALESCE(usuario_id, v_usuario)
  WHERE stripe_payment_intent_id = p_stripe_payment_intent_id AND pago_origen_id IS NULL
    AND tenant_id = COALESCE(v_tenant, tenant_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    UPDATE revisiones_financieras rf SET estado = 'resuelta', resolucion = 'reconciliado', resuelta_at = now(), actor_rol = 'sistema', updated_at = now()
    WHERE rf.tipo = 'origen_no_resuelto' AND rf.estado = 'abierta'
      AND rf.referencia IN (SELECT stripe_object_id FROM reversales_pago WHERE pago_origen_id = v_pago_id);
  END IF;
  RETURN jsonb_build_object('success', true, 'reatribuidos', v_n);
END;
$$;
REVOKE ALL ON FUNCTION reatribuir_reversales(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reatribuir_reversales(text) TO service_role;

-- ── 8. RPC: vincular el pago de origen a las 'alta' de la membresía (write-once)
-- Igual que 7: se llama en el paso verificado; si no se llama, las 'alta'
-- compra_stripe/suscripcion_stripe sin vínculo quedan consultables.
CREATE OR REPLACE FUNCTION vincular_origen_valor(p_membresia_id uuid, p_payment_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer := 0;
BEGIN
  IF p_membresia_id IS NULL OR p_payment_event_id IS NULL THEN
    RETURN jsonb_build_object('success', true, 'vinculados', 0);
  END IF;
  UPDATE membresia_movimientos
  SET origen_payment_event_id = p_payment_event_id
  WHERE membresia_id = p_membresia_id AND tipo = 'alta'
    AND origen IN ('compra_stripe', 'suscripcion_stripe') AND origen_payment_event_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'vinculados', v_n);
END;
$$;
REVOKE ALL ON FUNCTION vincular_origen_valor(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION vincular_origen_valor(uuid, uuid) TO service_role;

-- Pendientes de vínculo (recuperación durable, consultable por el admin).
CREATE OR REPLACE VIEW movimientos_sin_vinculo AS
  SELECT m.id, m.tenant_id, m.membresia_id, m.usuario_id, m.origen, m.delta, m.created_at
  FROM membresia_movimientos m
  WHERE m.tipo = 'alta' AND m.origen IN ('compra_stripe', 'suscripcion_stripe') AND m.origen_payment_event_id IS NULL;
GRANT SELECT ON movimientos_sin_vinculo TO authenticated, service_role;

-- ── 9. RPC: desautorización de Connect ───────────────────────────────────────
CREATE OR REPLACE FUNCTION marcar_cuenta_desautorizada(p_stripe_account text, p_stripe_event_id text, p_evento_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant tenants;
BEGIN
  SELECT * INTO v_tenant FROM tenants WHERE stripe_account_id = p_stripe_account FOR UPDATE;
  IF v_tenant.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'cuenta_no_encontrada');
  END IF;
  IF v_tenant.stripe_desconectado_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'tenant_id', v_tenant.id);
  END IF;
  -- Se conserva stripe_account_id: trazabilidad de eventos y reversals.
  UPDATE tenants SET stripe_charges_enabled = false, stripe_desconectado_at = COALESCE(p_evento_at, now())
  WHERE id = v_tenant.id;
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, metadata)
  VALUES (v_tenant.id, NULL, 'sistema', 'stripe_cuenta_desautorizada', 'tenant', v_tenant.id,
          jsonb_build_object('stripe_charges_enabled', v_tenant.stripe_charges_enabled, 'stripe_desconectado_at', NULL),
          jsonb_build_object('stripe_charges_enabled', false, 'stripe_desconectado_at', COALESCE(p_evento_at, now())),
          jsonb_build_object('stripe_account', p_stripe_account, 'stripe_event_id', p_stripe_event_id));
  INSERT INTO revisiones_financieras (tenant_id, tipo, referencia, detalle)
  VALUES (v_tenant.id, 'cuenta_desautorizada', p_stripe_account, jsonb_build_object('stripe_event_id', p_stripe_event_id))
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('success', true, 'idempotente', false, 'tenant_id', v_tenant.id);
END;
$$;
REVOKE ALL ON FUNCTION marcar_cuenta_desautorizada(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION marcar_cuenta_desautorizada(text, text, timestamptz) TO service_role;

-- ── 10. RPC: resolver una revisión (admin; documenta, NO muta derechos) ──────
CREATE OR REPLACE FUNCTION resolver_revision_financiera(p_revision_id uuid, p_resolucion text, p_nota text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_rol text := get_my_rol();
  v_tenant uuid := get_my_tenant_id();
  v_rev revisiones_financieras;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF v_rol <> 'admin' THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede resolver revisiones financieras';
  END IF;
  IF p_resolucion NOT IN ('sin_efecto', 'ajuste_manual_registrado', 'otro') THEN
    RAISE EXCEPTION 'EKKO_RESOLUCION_INVALIDA: resolución % no permitida', p_resolucion;
  END IF;
  IF COALESCE(length(trim(p_nota)), 0) < 10 THEN
    RAISE EXCEPTION 'EKKO_NOTA_REQUERIDA: Explica la resolución (mínimo 10 caracteres)';
  END IF;
  SELECT * INTO v_rev FROM revisiones_financieras WHERE id = p_revision_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_rev.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_REVISION_INVALIDA: Revisión no encontrada o de otro estudio';
  END IF;
  IF v_rev.estado = 'resuelta' THEN
    IF v_rev.resolucion = p_resolucion THEN
      RETURN jsonb_build_object('success', true, 'idempotente', true, 'revision_id', v_rev.id);
    END IF;
    RAISE EXCEPTION 'EKKO_REVISION_RESUELTA: Ya está resuelta como %', v_rev.resolucion;
  END IF;
  UPDATE revisiones_financieras
  SET estado = 'resuelta', resolucion = p_resolucion, nota = trim(p_nota), actor_usuario_id = v_actor, actor_rol = v_rol,
      resuelta_at = now(), updated_at = now()
  WHERE id = v_rev.id;
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'revision_financiera_resuelta', 'revision_financiera', v_rev.id,
          jsonb_build_object('estado', 'abierta', 'tipo', v_rev.tipo),
          jsonb_build_object('estado', 'resuelta', 'resolucion', p_resolucion),
          trim(p_nota), jsonb_build_object('reversal_id', v_rev.reversal_id, 'referencia', v_rev.referencia));
  RETURN jsonb_build_object('success', true, 'idempotente', false, 'revision_id', v_rev.id);
END;
$$;
REVOKE ALL ON FUNCTION resolver_revision_financiera(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION resolver_revision_financiera(uuid, text, text) TO authenticated;
