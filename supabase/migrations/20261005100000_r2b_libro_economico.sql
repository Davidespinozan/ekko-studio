-- ============================================================================
-- R2-B · PKG-01N · LIBRO ECONÓMICO (lectura canónica de dinero cobrado y revertido)
-- ----------------------------------------------------------------------------
-- NO es un segundo sistema contable: es UNA vista que compone la evidencia que
-- ya existe, sin copiar dinero a otra tabla y sin escribir nada:
--
--   payment_events        cobros de Stripe (factura de suscripción, paquete,
--                         invitados extra, cobro con tarjeta en mostrador)
--   ventas_mostrador      efectivo / transferencia / terminal / cortesía
--   reversales_pago       un Refund o Dispute de Stripe = una fila (01G)
--   stripe_webhook_events cobros que Stripe reportó pero que NO llegaron al
--                         diario (evento en revisión o con error)
--
-- Reglas (invariantes de R2-B):
--   · BRUTO  = cobros con evidencia FIRME, cada uno una vez.
--   · REVERSADO = reembolsos `succeeded` y disputas `lost`, por su monto EXACTO,
--     solo cuando su pago de origen está resuelto y es firme.
--   · NETO = SUM(efecto_neto_centavos). Nunca se resta un monto adivinado.
--   · Lo que no se puede atribuir queda `sin_resolver` (visible, fuera del neto):
--     PaymentIntents históricos sin metadata de EKKO, reversales sin origen,
--     cobros cuyo evento quedó en revisión. No se fabrica atribución histórica.
--   · Un PaymentIntent de invitados extra vive en payment_events Y en
--     invitados_extra_pagos: el dinero se cuenta UNA vez (payment_events); la
--     otra tabla solo aporta el estado de aplicación.
--   · Reembolso fallido/cancelado y disputa ganada o cerrada por reembolso no
--     restan. Disputa abierta = `en_disputa` (no resta hasta perderse).
--   · La moneda se normaliza a minúsculas (Stripe 'mxn', mostrador 'MXN').
--   · La fecha es la del PROVEEDOR (cuándo ocurrió), no la de inserción.
--
-- No cambia derechos, créditos, membresías ni evidencia de 01G/01H. Aditiva.
-- ============================================================================

CREATE OR REPLACE VIEW v_libro_economico
WITH (security_invoker = true) AS
WITH pagos_base AS (
  SELECT
    pe.id,
    -- Tenant: el del diario; si falta, el de la cuenta conectada del evento
    -- (solo si esa cuenta es de UN tenant: nunca se adivina).
    COALESCE(pe.tenant_id, (
      SELECT (array_agg(t.id))[1] FROM tenants t
      WHERE t.stripe_account_id IS NOT NULL
        AND t.stripe_account_id = COALESCE(swe.stripe_account, pe.raw_payload->>'account')
      HAVING count(*) = 1
    )) AS tenant_id,
    pe.usuario_id,
    pe.membresia_id,
    lower(COALESCE(pe.moneda, 'mxn')) AS moneda,
    COALESCE(pe.monto_centavos, 0) AS monto_centavos,
    pe.stripe_event_type,
    pe.stripe_payment_intent_id,
    pe.stripe_invoice_id,
    pe.raw_payload #>> '{data,object,metadata,app}'    AS meta_app,
    pe.raw_payload #>> '{data,object,metadata,tipo}'   AS meta_tipo,
    pe.raw_payload #>> '{data,object,metadata,origen}' AS meta_origen,
    pe.raw_payload #>> '{data,object,billing_reason}'  AS billing_reason,
    COALESCE(
      swe.event_created_at,
      CASE WHEN pe.raw_payload->>'created' ~ '^\d+$' THEN to_timestamp((pe.raw_payload->>'created')::bigint) END,
      pe.created_at
    ) AS ocurrido_at,
    pe.created_at AS registrado_at
  FROM payment_events pe
  LEFT JOIN stripe_webhook_events swe ON swe.id = pe.stripe_event_id
  WHERE pe.status = 'succeeded'
    AND pe.stripe_event_type IN ('invoice.paid', 'payment_intent.succeeded')
),
pagos AS (
  SELECT
    b.*,
    CASE
      WHEN b.stripe_event_type = 'invoice.paid' THEN
        CASE b.billing_reason
          WHEN 'subscription_create' THEN 'suscripcion_alta'
          WHEN 'subscription_cycle'  THEN 'suscripcion_renovacion'
          WHEN 'subscription_update' THEN 'cambio_de_plan'
          ELSE 'suscripcion'
        END
      WHEN b.meta_app = 'ekko' AND b.meta_tipo = 'invitados_extra' THEN 'invitados_extra'
      WHEN b.meta_app = 'ekko' THEN 'paquete'
      ELSE 'desconocido'
    END AS origen_negocio,
    CASE WHEN b.meta_origen = 'mostrador' THEN 'mostrador_stripe' ELSE 'app' END AS canal,
    CASE
      WHEN b.stripe_event_type = 'invoice.paid' THEN 'firme'
      -- Un PaymentIntent que además pagó una factura ya contada: no se cuenta dos veces.
      WHEN b.stripe_payment_intent_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM payment_events f
             WHERE f.stripe_event_type = 'invoice.paid' AND f.status = 'succeeded'
               AND f.stripe_payment_intent_id = b.stripe_payment_intent_id) THEN 'excluido'
      WHEN b.meta_app = 'ekko' THEN 'firme'
      -- Histórico (antes del filtro por metadata): no se sabe si es un paquete
      -- o el PaymentIntent de una factura ya contada. Queda sin resolver.
      WHEN b.meta_app IS NULL THEN 'sin_resolver'
      ELSE 'excluido'
    END AS estado_evidencia,
    CASE
      WHEN b.stripe_event_type = 'invoice.paid' THEN NULL
      WHEN b.stripe_payment_intent_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM payment_events f
             WHERE f.stripe_event_type = 'invoice.paid' AND f.status = 'succeeded'
               AND f.stripe_payment_intent_id = b.stripe_payment_intent_id) THEN 'duplicado_de_factura'
      WHEN b.meta_app = 'ekko' THEN NULL
      WHEN b.meta_app IS NULL THEN 'pi_sin_metadata_ekko'
      ELSE 'app_ajena'
    END AS motivo_base
  FROM pagos_base b
)
-- ── 1. Cobros de Stripe ──────────────────────────────────────────────────────
SELECT
  p.tenant_id,
  'payment_events'::text                       AS fuente,
  p.id::text                                   AS fuente_id,
  'cobro'::text                                AS clase,
  p.origen_negocio,
  p.canal,
  p.usuario_id,
  p.membresia_id,
  p.moneda,
  p.monto_centavos,
  CASE WHEN p.estado_evidencia = 'firme' THEN p.monto_centavos ELSE 0 END AS efecto_neto_centavos,
  p.estado_evidencia,
  COALESCE(p.motivo_base,
           CASE WHEN iep.estado = 'no_aplicado' THEN 'extra_no_aplicado:' || COALESCE(iep.motivo, '') END) AS motivo,
  p.ocurrido_at,
  p.registrado_at,
  p.stripe_payment_intent_id,
  p.stripe_invoice_id,
  NULL::text                                   AS stripe_object_id,
  NULL::uuid                                   AS pago_origen_id,
  (
    EXISTS (SELECT 1 FROM revisiones_financieras rf
            WHERE rf.estado = 'abierta' AND rf.reversal_id IS NULL
              AND p.stripe_payment_intent_id IS NOT NULL AND rf.referencia = p.stripe_payment_intent_id)
    OR EXISTS (SELECT 1 FROM reversales_pago r
               JOIN revisiones_financieras rf ON rf.reversal_id = r.id AND rf.estado = 'abierta'
               WHERE r.pago_origen_id = p.id)
  )                                            AS revision_abierta
FROM pagos p
LEFT JOIN invitados_extra_pagos iep ON iep.stripe_payment_intent_id = p.stripe_payment_intent_id

UNION ALL
-- ── 2. Ventas de mostrador (efectivo / transferencia / terminal / cortesía) ──
SELECT
  v.tenant_id,
  'ventas_mostrador',
  v.id::text,
  CASE WHEN v.metodo = 'cortesia' THEN 'cortesia' ELSE 'cobro' END,
  CASE WHEN v.metodo = 'cortesia' THEN 'cortesia' ELSE 'venta_mostrador' END,
  'mostrador_' || v.metodo,
  v.usuario_id,
  v.membresia_id,
  lower(v.moneda),
  v.monto_cobrado_centavos,
  v.monto_cobrado_centavos,
  'firme',
  NULL,
  v.created_at,
  v.created_at,
  NULL, NULL, NULL, NULL,
  false
FROM ventas_mostrador v

UNION ALL
-- ── 3. Reversales (01G): un Refund / Dispute = una fila, monto exacto ────────
SELECT
  x.tenant_id,
  'reversales_pago',
  x.id::text,
  x.clase,
  COALESCE(x.origen_negocio, 'sin_origen'),
  COALESCE(x.canal, 'stripe'),
  x.usuario_id,
  x.membresia_origen_id,
  x.moneda,
  x.monto_centavos,
  CASE WHEN x.estado_final = 'firme' THEN -x.monto_centavos ELSE 0 END,
  x.estado_final,
  x.motivo,
  x.ocurrido_at,
  x.created_at,
  x.stripe_payment_intent_id,
  NULL,
  x.stripe_object_id,
  x.pago_origen_id,
  EXISTS (SELECT 1 FROM revisiones_financieras rf WHERE rf.reversal_id = x.id AND rf.estado = 'abierta')
FROM (
  SELECT
    rp.id, rp.tenant_id, rp.usuario_id, rp.membresia_origen_id, rp.monto_centavos,
    lower(rp.moneda) AS moneda, rp.stripe_payment_intent_id, rp.stripe_object_id, rp.pago_origen_id,
    rp.created_at, COALESCE(rp.stripe_created_at, rp.created_at) AS ocurrido_at,
    CASE rp.tipo WHEN 'reembolso' THEN 'reembolso' ELSE 'disputa' END AS clase,
    po.origen_negocio, po.canal,
    CASE
      WHEN e.base = 'firme' AND (po.id IS NULL OR po.estado_evidencia <> 'firme') THEN 'sin_resolver'
      ELSE e.base
    END AS estado_final,
    CASE
      WHEN e.base = 'firme' AND po.id IS NULL THEN 'reversal_sin_origen'
      WHEN e.base = 'firme' AND po.estado_evidencia <> 'firme' THEN 'reversal_de_pago_no_firme'
      WHEN e.base = 'anulado' THEN rp.tipo || '_' || rp.estado_proveedor
      WHEN e.base IN ('pendiente', 'en_disputa') THEN rp.estado_proveedor
    END AS motivo
  FROM reversales_pago rp
  LEFT JOIN pagos po ON po.id = rp.pago_origen_id
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN rp.tipo = 'reembolso' AND rp.estado_proveedor = 'succeeded' THEN 'firme'
      WHEN rp.tipo = 'reembolso' AND rp.estado_proveedor IN ('pending', 'requires_action') THEN 'pendiente'
      WHEN rp.tipo = 'disputa' AND rp.estado_proveedor = 'lost' THEN 'firme'
      WHEN rp.tipo = 'disputa' AND rp.estado_proveedor IN ('needs_response', 'under_review',
                                                          'warning_needs_response', 'warning_under_review') THEN 'en_disputa'
      -- reembolso failed/canceled; disputa won / warning_closed / charge_refunded
      -- (el reembolso que la cerró ya tiene su propia fila).
      ELSE 'anulado'
    END AS base
  ) e
) x

UNION ALL
-- ── 4. Cobros que Stripe reportó y NO están en el diario ────────────────────
-- Evento de cobro en `revision` o `error_reintentable` sin fila en
-- payment_events: el dinero pudo entrar a Stripe sin que EKKO lo registrara.
-- Visible y fuera del neto hasta que el evento se procese (entonces aparece en 1).
SELECT
  (SELECT (array_agg(t.id))[1] FROM tenants t
   WHERE t.stripe_account_id IS NOT NULL AND t.stripe_account_id = w.stripe_account
   HAVING count(*) = 1),
  'stripe_webhook_events',
  w.id,
  'cobro',
  CASE
    WHEN w.type = 'invoice.paid' THEN 'suscripcion'
    WHEN w.resumen #>> '{metadata,tipo}' = 'invitados_extra' THEN 'invitados_extra'
    ELSE 'paquete'
  END,
  'app',
  NULL::uuid,
  NULL::uuid,
  lower(COALESCE(w.resumen->>'currency', 'mxn')),
  CASE WHEN w.resumen->>'monto' ~ '^\d+$' THEN (w.resumen->>'monto')::integer ELSE 0 END,
  0,
  'sin_resolver',
  'evento_' || w.estado || COALESCE(':' || w.motivo, ''),
  COALESCE(w.event_created_at, w.received_at),
  w.received_at,
  CASE WHEN w.type = 'payment_intent.succeeded' THEN w.resumen->>'id' ELSE w.resumen->>'payment_intent' END,
  CASE WHEN w.type = 'invoice.paid' THEN w.resumen->>'id' END,
  NULL,
  NULL::uuid,
  EXISTS (SELECT 1 FROM revisiones_financieras rf
          WHERE rf.estado = 'abierta' AND rf.reversal_id IS NULL AND rf.referencia = w.resumen->>'id')
FROM stripe_webhook_events w
WHERE w.estado IN ('revision', 'error_reintentable')
  AND (w.type = 'invoice.paid'
       OR (w.type = 'payment_intent.succeeded' AND w.resumen #>> '{metadata,app}' = 'ekko'))
  AND NOT EXISTS (SELECT 1 FROM payment_events pe WHERE pe.stripe_event_id = w.id);

COMMENT ON VIEW v_libro_economico IS
  'R2-B/01N: lectura canónica del dinero. BRUTO = cobros firmes; NETO = SUM(efecto_neto_centavos); lo no atribuible queda sin_resolver fuera del neto. Solo compone evidencia existente; no escribe ni cambia derechos.';

-- La vista NO se expone por REST: stripe_webhook_events no tiene policies y el
-- tenant de algunas filas se resuelve por la cuenta conectada. El admin la lee
-- por la RPC (su estudio, su rango).
REVOKE ALL ON v_libro_economico FROM PUBLIC, anon, authenticated;
GRANT SELECT ON v_libro_economico TO service_role;

CREATE OR REPLACE FUNCTION libro_economico(p_desde timestamptz, p_hasta timestamptz)
RETURNS SETOF v_libro_economico
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
BEGIN
  IF v_tenant IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede leer el libro económico';
  END IF;
  IF p_desde IS NULL OR p_hasta IS NULL OR p_hasta <= p_desde THEN
    RAISE EXCEPTION 'EKKO_RANGO_INVALIDO: Rango de fechas inválido';
  END IF;
  RETURN QUERY
    SELECT l.* FROM v_libro_economico l
    WHERE l.tenant_id = v_tenant AND l.ocurrido_at >= p_desde AND l.ocurrido_at < p_hasta
    ORDER BY l.ocurrido_at, l.fuente, l.fuente_id;
END;
$$;
REVOKE ALL ON FUNCTION libro_economico(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION libro_economico(timestamptz, timestamptz) TO authenticated;
