-- ============================================================================
-- PKG-06B · Operaciones de cobro del MIEMBRO y del WEBHOOK, durables (EKKO-145)
-- ============================================================================
-- Tres caminos mutaban Stripe sin evidencia durable propia:
--  FR-15 cambio de plan del miembro: si Stripe aceptaba y EKKO no convergía (o la
--        respuesta era ambigua) solo quedaba un log; si el miembro no reintentaba,
--        nadie lo veía hasta la reconciliación del día siguiente (03B).
--  FR-16 baja / reactivación del miembro al fin del periodo: Stripe primero, EKKO
--        después por el webhook; sin registro de la intención del miembro.
--  FR-17 el webhook cancelaba la(s) suscripción(es) anterior(es) "best-effort":
--        un fallo dejaba DOS suscripciones cobrando y solo un console.error.
--
-- Se reutiliza `stripe_operaciones_suscripcion` (R2-B / 02H), sin tabla nueva:
--  · tipos nuevos: `cambiar_plan` (lo ejecuta el propio flujo del miembro; el
--    ejecutor NUNCA lo toca) y `reanudar_renovacion` (cancel_at_period_end=false);
--  · causas nuevas: `cambio_plan_miembro`, `baja_miembro`, `reactivacion_miembro`,
--    `suscripcion_anterior`;
--  · columna `contexto` (jsonb, sin PII ni payloads): operation_id del miembro,
--    tier destino, suscripción nueva y evento de Stripe que lo originó.
--  · RPC: `cambio_plan_registrar` / `cambio_plan_resultado` (service_role),
--    `miembro_programar_renovacion` (el miembro, por sí mismo),
--    `registrar_cancelacion_suscripcion_anterior` (service_role, desde el webhook).
--  · `operacion_suscripcion_preparar` / `_resultado` y
--    `staff_reintentar_operacion_cobro` se recrean desde su ÚLTIMA definición con
--    las ramas nuevas; lo demás idéntico.
--  · `v_pendientes_operativos`: misma vista de 06G; en la rama de cobro, la
--    suscripción anterior sin cancelar es severidad ALTA y un cambio de plan sin
--    confirmar se revisa (no se "reintenta" desde el panel).
-- Aditiva: el código desplegado no crea filas de los tipos nuevos y su ejecutor
-- sigue funcionando (preparar nunca entrega un `cambiar_plan`).
-- ============================================================================

-- ── 1. Tipos, causas y contexto ─────────────────────────────────────────────
ALTER TABLE stripe_operaciones_suscripcion DROP CONSTRAINT IF EXISTS stripe_operaciones_suscripcion_tipo_check;
ALTER TABLE stripe_operaciones_suscripcion ADD CONSTRAINT stripe_operaciones_suscripcion_tipo_check
  CHECK (tipo IN ('suspender_cobro', 'reanudar_cobro', 'cancelar_suscripcion', 'cancelar_fin_periodo',
                  'reanudar_renovacion', 'cambiar_plan'));
ALTER TABLE stripe_operaciones_suscripcion DROP CONSTRAINT IF EXISTS stripe_operaciones_suscripcion_causa_check;
ALTER TABLE stripe_operaciones_suscripcion ADD CONSTRAINT stripe_operaciones_suscripcion_causa_check
  CHECK (causa IN ('sancion', 'levantar_sancion', 'revocacion', 'baja_inmediata', 'pausa_staff', 'reactivacion_staff',
                   'baja_fin_periodo', 'cambio_plan_miembro', 'baja_miembro', 'reactivacion_miembro', 'suscripcion_anterior'));
ALTER TABLE stripe_operaciones_suscripcion
  ADD COLUMN IF NOT EXISTS contexto jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN stripe_operaciones_suscripcion.contexto IS
  'PKG-06B: contexto mínimo de la operación (operation_id, tier destino, suscripción nueva, evento). Sin PII ni payloads del proveedor.';

-- ── 2. Preparar (desde 02H): ramas para los tipos y causas nuevos ───────────
CREATE OR REPLACE FUNCTION operacion_suscripcion_preparar(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o       stripe_operaciones_suscripcion;
  v_u       usuarios;
  v_m       membresias;
  v_motivo  text;
BEGIN
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE id = p_id FOR UPDATE;
  IF v_o.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_NO_EXISTE: Operación no encontrada';
  END IF;
  IF v_o.estado NOT IN ('pendiente', 'fallida') THEN
    RETURN jsonb_build_object('ejecutar', false, 'estado', v_o.estado, 'motivo', 'ya_' || v_o.estado);
  END IF;
  -- PKG-06B: el cambio de plan lo ejecuta el flujo del miembro (precio, prorrata,
  -- cobro); el ejecutor genérico jamás lo toca ni lo cierra.
  IF v_o.tipo = 'cambiar_plan' THEN
    RETURN jsonb_build_object('ejecutar', false, 'estado', v_o.estado, 'motivo', 'lo_ejecuta_el_miembro');
  END IF;

  SELECT * INTO v_u FROM usuarios WHERE id = v_o.usuario_id;
  SELECT * INTO v_m FROM membresias WHERE id = v_o.membresia_id;

  IF v_o.tipo = 'suspender_cobro' AND v_o.causa = 'pausa_staff' THEN
    -- PKG-02H: pausa del staff. Solo procede si la intención sigue vigente.
    v_motivo := CASE
      WHEN v_u.id IS NULL OR v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_u.status = 'revocado' THEN 'cuenta_revocada'
      WHEN v_m.pausa_comercial_at IS NULL THEN 'reactivada'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
    END;
  ELSIF v_o.tipo = 'suspender_cobro' THEN
    v_motivo := CASE
      WHEN v_u.id IS NULL OR v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_u.status = 'revocado' THEN 'cuenta_revocada'
      WHEN v_u.sancionado_at IS NULL THEN 'sancion_levantada'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
    END;
  ELSIF v_o.tipo = 'reanudar_cobro' THEN
    -- No se resucita nada: solo se reanuda si TODO sigue siendo válido.
    v_motivo := CASE
      WHEN v_u.id IS NULL OR v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_u.status = 'revocado' THEN 'cuenta_revocada'
      WHEN v_u.sancionado_at IS NOT NULL THEN 'sancion_vigente'
      -- EKKO-138: el staff pausó la membresía mientras esta reanudación esperaba.
      WHEN v_m.pausa_comercial_at IS NOT NULL THEN 'pausa_comercial_vigente'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
    END;
  ELSIF v_o.tipo = 'cancelar_fin_periodo' THEN
    -- PKG-02H: baja al fin del periodo. Si la membresía ya terminó (baja inmediata
    -- posterior, cancelación desde Stripe, expiración) ya no hay qué programar.
    -- PKG-06B: misma regla para la baja que pide el miembro (causa baja_miembro).
    v_motivo := CASE
      WHEN v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN NOT COALESCE(v_m.cancel_at_period_end, false) THEN 'cancelacion_revertida'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
      WHEN EXISTS (SELECT 1 FROM membresias x
                   WHERE x.stripe_subscription_id = v_o.stripe_subscription_id
                     AND x.id IS DISTINCT FROM v_o.membresia_id
                     AND x.status IN ('trialing', 'activa', 'past_due', 'pausada'))
        THEN 'suscripcion_en_uso_por_otra_membresia'
    END;
  ELSIF v_o.tipo = 'reanudar_renovacion' THEN
    -- PKG-06B: el miembro revierte SU baja programada. La revocación y la sanción
    -- mandan; si la baja se volvió a programar o la membresía terminó, ya no aplica.
    v_motivo := CASE
      WHEN v_u.id IS NULL OR v_m.id IS NULL THEN 'sin_sujeto'
      WHEN v_u.status = 'revocado' THEN 'cuenta_revocada'
      WHEN v_u.sancionado_at IS NOT NULL THEN 'sancion_vigente'
      WHEN v_m.status NOT IN ('trialing', 'activa', 'past_due', 'pausada') THEN 'membresia_no_vigente'
      WHEN COALESCE(v_m.cancel_at_period_end, false) THEN 'cancelacion_reprogramada'
      WHEN v_m.stripe_subscription_id IS DISTINCT FROM v_o.stripe_subscription_id THEN 'suscripcion_distinta'
    END;
  ELSE
    -- PKG-06B: suscripción ANTERIOR tras activar una nueva. Mientras la membresía
    -- anterior siga viva en EKKO (la activación aún no terminó), se espera sin
    -- descartar: queda pendiente y, si se atasca, visible en Operación.
    IF v_o.causa = 'suscripcion_anterior' AND v_m.id IS NOT NULL
       AND v_m.status IN ('trialing', 'activa', 'past_due', 'pausada') THEN
      RETURN jsonb_build_object('ejecutar', false, 'estado', v_o.estado, 'motivo', 'membresia_anterior_vigente');
    END IF;
    -- cancelar: no tocar una suscripción que hoy sostiene OTRA membresía viva.
    v_motivo := CASE
      WHEN EXISTS (SELECT 1 FROM membresias x
                   WHERE x.stripe_subscription_id = v_o.stripe_subscription_id
                     AND x.id IS DISTINCT FROM v_o.membresia_id
                     AND x.status IN ('trialing', 'activa', 'past_due', 'pausada'))
        THEN 'suscripcion_en_uso_por_otra_membresia'
    END;
  END IF;

  IF v_motivo IS NOT NULL THEN
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'descartada', motivo_descarte = v_motivo
    WHERE id = v_o.id;
    RETURN jsonb_build_object('ejecutar', false, 'estado', 'descartada', 'motivo', v_motivo);
  END IF;

  UPDATE stripe_operaciones_suscripcion
  SET intentos = intentos + 1, ultimo_intento_at = now()
  WHERE id = v_o.id
  RETURNING * INTO v_o;

  RETURN jsonb_build_object(
    'ejecutar', true, 'id', v_o.id, 'tipo', v_o.tipo, 'tenant_id', v_o.tenant_id,
    'stripe_subscription_id', v_o.stripe_subscription_id,
    -- Llave de idempotencia del proveedor: misma operación + mismo intento.
    'idempotency_key', 'ekko:' || v_o.operation_key || ':' || v_o.intentos,
    'intento', v_o.intentos);
END;
$$;

-- ── 3. Resultado (desde 02H): avisos de las causas nuevas ───────────────────
CREATE OR REPLACE FUNCTION operacion_suscripcion_resultado(p_id uuid, p_ok boolean, p_error text, p_resultado jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o stripe_operaciones_suscripcion;
  v_estado_previo text;
BEGIN
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE id = p_id FOR UPDATE;
  IF v_o.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_NO_EXISTE: Operación no encontrada';
  END IF;
  -- PKG-06B: el cambio de plan se cierra por cambio_plan_resultado, nunca por aquí.
  IF v_o.tipo = 'cambiar_plan' THEN
    RAISE EXCEPTION 'EKKO_OPERACION_INVALIDA: El cambio de plan no lo asienta el ejecutor';
  END IF;
  IF v_o.estado = 'aplicada' THEN
    RETURN jsonb_build_object('success', true, 'estado', 'aplicada', 'idempotente', true);
  END IF;
  v_estado_previo := v_o.estado;

  IF p_ok THEN
    -- Aunque EKKO la hubiera descartado mientras estaba en vuelo: el proveedor la
    -- aplicó y eso es lo que queda asentado.
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'aplicada', aplicada_at = now(), ultimo_error = NULL,
        resultado = COALESCE(p_resultado, '{}'::jsonb), reintentos_agotados_at = NULL
    WHERE id = v_o.id;
    -- Encadena lo que falte (p. ej. se levantó la sanción mientras se suspendía).
    IF v_o.tipo IN ('suspender_cobro', 'reanudar_cobro') AND v_o.usuario_id IS NOT NULL THEN
      PERFORM _reconciliar_cobro_sancion(v_o.usuario_id);
    END IF;
    RETURN jsonb_build_object('success', true, 'estado', 'aplicada', 'idempotente', false);
  END IF;

  IF v_o.estado = 'descartada' THEN
    RETURN jsonb_build_object('success', true, 'estado', 'descartada');
  END IF;

  UPDATE stripe_operaciones_suscripcion
  SET estado = 'fallida', ultimo_error = left(COALESCE(p_error, 'error_desconocido'), 300),
      resultado = COALESCE(p_resultado, resultado),
      -- PKG-03A: tope de 5 intentos automáticos por ronda.
      reintentos_agotados_at = CASE WHEN intentos - intentos_ronda_base >= 5 THEN now() ELSE NULL END
  WHERE id = v_o.id
  RETURNING * INTO v_o;

  IF v_o.reintentos_agotados_at IS NOT NULL THEN
    PERFORM _avisar_admins(
      v_o.tenant_id, 'stripe_revision',
      'Un cambio de cobro necesita tu decisión',
      'Stripe no aplicó un cambio de cobro tras varios intentos y ya no se reintentará solo. Revísalo en Operación: reintentar o descartar con nota.',
      jsonb_build_object('operacion_id', v_o.id, 'tipo', v_o.tipo, 'causa', v_o.causa,
                         'usuario_id', v_o.usuario_id, 'url', '/admin/operacion'));
  ELSIF v_estado_previo = 'pendiente' THEN
    PERFORM _avisar_admins(
      v_o.tenant_id, 'stripe_revision',
      CASE WHEN v_o.causa = 'suscripcion_anterior' THEN 'Posible doble cobro: no se canceló la suscripción anterior'
           ELSE 'Stripe no aplicó un cambio de cobro' END,
      CASE
        WHEN v_o.causa = 'pausa_staff' THEN 'No se pudo PAUSAR el cobro en Stripe de una membresía que el staff puso en pausa. La pausa en EKKO sigue vigente; se reintentará.'
        WHEN v_o.causa = 'reactivacion_staff' THEN 'No se pudo REANUDAR el cobro en Stripe de una membresía reactivada por el staff. Se reintentará.'
        -- PKG-06B
        WHEN v_o.causa = 'suscripcion_anterior' THEN 'Un miembro activó un plan nuevo y Stripe no canceló su suscripción anterior: podría estar pagando dos. Se reintentará; revísalo en Operación y en el panel de Stripe.'
        WHEN v_o.causa = 'baja_miembro' THEN 'No se pudo programar en Stripe la baja al fin del periodo que pidió un miembro. En EKKO ya quedó programada; se reintentará.'
        WHEN v_o.causa = 'reactivacion_miembro' THEN 'No se pudo quitar en Stripe la baja programada de un miembro que reactivó su plan. Se reintentará.'
        WHEN v_o.tipo = 'cancelar_fin_periodo' THEN 'No se pudo programar en Stripe la cancelación al fin del periodo de una baja. La baja en EKKO sigue vigente; se reintentará.'
        WHEN v_o.tipo = 'suspender_cobro' THEN 'No se pudo SUSPENDER el cobro de un miembro sancionado. La sanción sigue vigente; el cobro se reintentará.'
        WHEN v_o.tipo = 'reanudar_cobro' THEN 'No se pudo REANUDAR el cobro de un miembro al que se le levantó la sanción. Se reintentará.'
        ELSE 'No se pudo CANCELAR en Stripe la suscripción de una cuenta dada de baja o revocada. El acceso sigue bloqueado; se reintentará.'
      END,
      jsonb_build_object('operacion_id', v_o.id, 'tipo', v_o.tipo, 'causa', v_o.causa,
                         'usuario_id', v_o.usuario_id,
                         'url', CASE WHEN v_o.causa = 'suscripcion_anterior' THEN '/admin/operacion'
                                     ELSE '/admin/miembros/' || COALESCE(v_o.usuario_id::text, '') END));
  END IF;
  RETURN jsonb_build_object('success', true, 'estado', 'fallida', 'agotada', v_o.reintentos_agotados_at IS NOT NULL);
END;
$$;

-- ── 4. Reintento desde Operación (desde 03A): el cambio de plan no se reintenta ─
CREATE OR REPLACE FUNCTION staff_reintentar_operacion_cobro(p_operacion_id uuid, p_nota text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_rol text := get_my_rol();
  v_o stripe_operaciones_suscripcion;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede reintentar operaciones de cobro';
  END IF;
  IF COALESCE(length(trim(p_nota)), 0) < 10 THEN
    RAISE EXCEPTION 'EKKO_NOTA_REQUERIDA: Explica por qué se reintenta (mínimo 10 caracteres)';
  END IF;
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE id = p_operacion_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_o.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_INVALIDA: Operación no encontrada o de otro estudio';
  END IF;
  -- PKG-06B: un cambio de plan lo reintenta el miembro (misma operación) o se
  -- revisa y descarta con nota; el panel no muta Stripe por él.
  IF v_o.tipo = 'cambiar_plan' THEN
    RAISE EXCEPTION 'EKKO_OPERACION_NO_REINTENTABLE: Un cambio de plan no se reintenta desde Operación; revísalo en Stripe y descártalo con nota';
  END IF;
  IF v_o.estado IN ('aplicada', 'descartada') THEN
    RAISE EXCEPTION 'EKKO_OPERACION_CERRADA: La operación ya está %', v_o.estado;
  END IF;
  IF v_o.estado = 'pendiente' AND v_o.reintentos_agotados_at IS NULL THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'estado', 'pendiente');
  END IF;

  UPDATE stripe_operaciones_suscripcion
  SET estado = 'pendiente', reintentos_agotados_at = NULL, intentos_ronda_base = intentos,
      revisada_at = now(), revisada_por = v_actor, nota_revision = trim(p_nota)
  WHERE id = v_o.id;
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'operacion_cobro_reintentada', 'operacion_cobro', v_o.id,
          jsonb_build_object('estado', v_o.estado, 'intentos', v_o.intentos, 'agotada', v_o.reintentos_agotados_at IS NOT NULL),
          jsonb_build_object('estado', 'pendiente'),
          trim(p_nota), jsonb_build_object('tipo', v_o.tipo, 'causa', v_o.causa, 'usuario_id', v_o.usuario_id));
  RETURN jsonb_build_object('success', true, 'idempotente', false, 'estado', 'pendiente', 'usuario_id', v_o.usuario_id);
END;
$$;

-- ── 5. FR-15 · Cambio de plan del miembro ───────────────────────────────────
-- Intención durable en el punto seguro: DESPUÉS de los guardias y del precio, y
-- ANTES de mutar la suscripción. Identidad = operation_id del miembro (el mismo
-- que viaja a Stripe en la llave `ekko:v1:swap_mensual:<acct>:<usuario>:<op>`).
CREATE OR REPLACE FUNCTION cambio_plan_registrar(
  p_operation_id uuid, p_usuario_id uuid, p_membresia_id uuid, p_tier_destino uuid, p_direccion text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_m membresias;
  v_o stripe_operaciones_suscripcion;
  v_key text := 'cambiar_plan:' || p_operation_id::text;
BEGIN
  IF p_direccion NOT IN ('upgrade', 'downgrade', 'lateral') THEN
    RAISE EXCEPTION 'EKKO_DIRECCION_INVALIDA: %', p_direccion;
  END IF;
  SELECT * INTO v_m FROM membresias WHERE id = p_membresia_id AND usuario_id = p_usuario_id;
  IF v_m.id IS NULL OR v_m.stripe_subscription_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MEMBRESIA_INVALIDA: La membresía no es del miembro o no tiene suscripción';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tiers t WHERE t.id = p_tier_destino AND t.tenant_id = v_m.tenant_id) THEN
    RAISE EXCEPTION 'EKKO_TIER_INVALIDO: El plan destino no es del estudio';
  END IF;

  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE operation_key = v_key FOR UPDATE;
  IF v_o.id IS NOT NULL THEN
    IF v_o.usuario_id IS DISTINCT FROM p_usuario_id OR (v_o.contexto ->> 'tier_destino') IS DISTINCT FROM p_tier_destino::text THEN
      RAISE EXCEPTION 'EKKO_OPERACION_CONFLICTO: Esta operación ya corresponde a otro cambio de plan';
    END IF;
    -- Un descarte por rechazo SIN efecto (p. ej. límite de Stripe) se reabre si el
    -- miembro reintenta con la MISMA operación.
    IF v_o.estado = 'descartada' THEN
      UPDATE stripe_operaciones_suscripcion SET estado = 'pendiente', motivo_descarte = NULL
      WHERE id = v_o.id RETURNING * INTO v_o;
    END IF;
    RETURN jsonb_build_object('id', v_o.id, 'estado', v_o.estado, 'existente', true);
  END IF;

  INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key, contexto)
  VALUES (v_m.tenant_id, p_usuario_id, v_m.id, v_m.stripe_subscription_id, 'cambiar_plan', 'cambio_plan_miembro', v_key,
          jsonb_build_object('operation_id', p_operation_id, 'tier_destino', p_tier_destino, 'tier_origen', v_m.tier_id,
                             'direccion', p_direccion))
  RETURNING * INTO v_o;
  RETURN jsonb_build_object('id', v_o.id, 'estado', v_o.estado, 'existente', false);
END;
$$;
REVOKE ALL ON FUNCTION cambio_plan_registrar(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cambio_plan_registrar(uuid, uuid, uuid, uuid, text) TO service_role;

-- Cierre honesto:
--  aplicada   = Stripe aplicó Y EKKO convergió (la membresía ya tiene el tier destino).
--  descartada = Stripe NO mutó (rechazo definitivo de cobro, rechazo sin efecto).
--  fallida    = resultado desconocido, cobro sin confirmar o Stripe sí y EKKO no:
--               visible en Operación; el reintento con la MISMA operación converge.
CREATE OR REPLACE FUNCTION cambio_plan_resultado(p_operation_id uuid, p_estado text, p_codigo text, p_resultado jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_o stripe_operaciones_suscripcion;
  v_tier uuid;
BEGIN
  IF p_estado NOT IN ('aplicada', 'descartada', 'fallida') THEN
    RAISE EXCEPTION 'EKKO_ESTADO_INVALIDO: %', p_estado;
  END IF;
  IF p_estado = 'descartada' AND p_codigo NOT IN ('cobro_fallido', 'pago_no_iniciable', 'sin_efecto') THEN
    RAISE EXCEPTION 'EKKO_CODIGO_INVALIDO: %', p_codigo;
  END IF;
  IF p_estado = 'fallida' AND p_codigo NOT IN ('resultado_desconocido', 'requiere_revision', 'db_pendiente',
                                               'operacion_conflicto', 'cuenta_restringida') THEN
    RAISE EXCEPTION 'EKKO_CODIGO_INVALIDO: %', p_codigo;
  END IF;
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion
  WHERE operation_key = 'cambiar_plan:' || p_operation_id::text FOR UPDATE;
  IF v_o.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_NO_EXISTE: Operación no encontrada';
  END IF;
  IF v_o.estado = 'aplicada' THEN
    RETURN jsonb_build_object('success', true, 'estado', 'aplicada', 'idempotente', true);
  END IF;

  IF p_estado = 'aplicada' THEN
    SELECT tier_id INTO v_tier FROM membresias WHERE id = v_o.membresia_id;
    IF v_tier IS DISTINCT FROM (v_o.contexto ->> 'tier_destino')::uuid THEN
      RAISE EXCEPTION 'EKKO_SIN_CONVERGENCIA: La membresía aún no tiene el plan destino';
    END IF;
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'aplicada', aplicada_at = now(), ultimo_error = NULL, ultimo_intento_at = now(),
        intentos = intentos + 1, resultado = COALESCE(p_resultado, '{}'::jsonb)
    WHERE id = v_o.id;
    RETURN jsonb_build_object('success', true, 'estado', 'aplicada', 'idempotente', false);
  END IF;

  IF p_estado = 'descartada' THEN
    UPDATE stripe_operaciones_suscripcion
    SET estado = 'descartada', motivo_descarte = p_codigo, ultimo_intento_at = now(), intentos = intentos + 1
    WHERE id = v_o.id;
    RETURN jsonb_build_object('success', true, 'estado', 'descartada');
  END IF;

  UPDATE stripe_operaciones_suscripcion
  SET estado = 'fallida', ultimo_error = p_codigo, ultimo_intento_at = now(), intentos = intentos + 1,
      resultado = COALESCE(p_resultado, resultado)
  WHERE id = v_o.id;
  IF v_o.estado = 'pendiente' THEN
    PERFORM _avisar_admins(
      v_o.tenant_id, 'stripe_revision',
      'Un cambio de plan quedó sin confirmar',
      'Un miembro cambió de plan y no se pudo confirmar que Stripe y EKKO coinciden. Revísalo en Operación y en el panel de Stripe.',
      jsonb_build_object('operacion_id', v_o.id, 'tipo', v_o.tipo, 'causa', v_o.causa,
                         'usuario_id', v_o.usuario_id, 'url', '/admin/operacion'));
  END IF;
  RETURN jsonb_build_object('success', true, 'estado', 'fallida');
END;
$$;
REVOKE ALL ON FUNCTION cambio_plan_resultado(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cambio_plan_resultado(uuid, text, text, jsonb) TO service_role;

-- ── 6. FR-16 · Baja / reactivación al fin del periodo, pedida por el miembro ─
-- El miembro (su sesión; el actor sale del servidor) deja su intención durable y
-- local en UNA transacción: cancel_at_period_end en EKKO + la operación para
-- Stripe. El derecho no se toca (la baja surte efecto al fin del periodo).
-- La reactivación no pasa por encima de revocación, sanción ni de una baja que
-- programó el ESTUDIO (02H).
CREATE OR REPLACE FUNCTION miembro_programar_renovacion(p_cancelar boolean, p_operation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_u usuarios;
  v_m membresias;
  v_o stripe_operaciones_suscripcion;
  v_key text;
  v_ultima_baja text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF p_cancelar IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_PARAMETROS_INVALIDOS: Falta la intención o la operación';
  END IF;
  SELECT * INTO v_u FROM usuarios WHERE id = v_actor;
  IF v_u.rol <> 'miembro' THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo el miembro gestiona su propia renovación';
  END IF;
  IF v_u.status = 'revocado' THEN
    RAISE EXCEPTION 'EKKO_CUENTA_REVOCADA: Tu acceso fue revocado por el estudio';
  END IF;

  v_key := 'renovacion_miembro:' || p_operation_id::text;
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE operation_key = v_key;
  IF v_o.id IS NOT NULL THEN
    IF v_o.usuario_id IS DISTINCT FROM v_actor
       OR v_o.tipo <> (CASE WHEN p_cancelar THEN 'cancelar_fin_periodo' ELSE 'reanudar_renovacion' END) THEN
      RAISE EXCEPTION 'EKKO_OPERACION_CONFLICTO: Esta operación ya corresponde a otra acción';
    END IF;
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'operacion_id', v_o.id, 'estado', v_o.estado,
                              'cancel_at_period_end', p_cancelar, 'usuario_id', v_actor);
  END IF;

  SELECT * INTO v_m FROM membresias
  WHERE usuario_id = v_actor AND stripe_subscription_id IS NOT NULL
    AND status IN ('trialing', 'activa', 'past_due', 'pausada')
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_m.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_SIN_SUSCRIPCION: No tienes una suscripción activa para gestionar';
  END IF;

  IF NOT p_cancelar THEN
    IF v_u.sancionado_at IS NOT NULL THEN
      RAISE EXCEPTION 'EKKO_CUENTA_RESTRINGIDA: Tu cuenta está suspendida por el estudio';
    END IF;
    SELECT causa INTO v_ultima_baja FROM stripe_operaciones_suscripcion
    WHERE membresia_id = v_m.id AND tipo = 'cancelar_fin_periodo' AND estado <> 'descartada'
    ORDER BY created_at DESC LIMIT 1;
    IF v_ultima_baja = 'baja_fin_periodo' AND COALESCE(v_m.cancel_at_period_end, false) THEN
      RAISE EXCEPTION 'EKKO_BAJA_DEL_ESTUDIO: La baja la programó el estudio; acércate a recepción para revertirla';
    END IF;
  END IF;

  UPDATE membresias SET cancel_at_period_end = p_cancelar, updated_at = now() WHERE id = v_m.id;

  INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key, contexto)
  VALUES (v_m.tenant_id, v_actor, v_m.id, v_m.stripe_subscription_id,
          CASE WHEN p_cancelar THEN 'cancelar_fin_periodo' ELSE 'reanudar_renovacion' END,
          CASE WHEN p_cancelar THEN 'baja_miembro' ELSE 'reactivacion_miembro' END,
          v_key, jsonb_build_object('operation_id', p_operation_id))
  RETURNING * INTO v_o;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, metadata)
  VALUES (v_m.tenant_id, v_actor, 'miembro',
          CASE WHEN p_cancelar THEN 'baja_programada_por_miembro' ELSE 'renovacion_reactivada_por_miembro' END,
          'usuario', v_actor,
          jsonb_build_object('cancel_at_period_end', COALESCE(v_m.cancel_at_period_end, false)),
          jsonb_build_object('cancel_at_period_end', p_cancelar),
          jsonb_build_object('membresia_id', v_m.id, 'operacion_id', v_o.id));

  RETURN jsonb_build_object('success', true, 'idempotente', false, 'operacion_id', v_o.id, 'estado', v_o.estado,
                            'cancel_at_period_end', p_cancelar, 'usuario_id', v_actor);
END;
$$;
REVOKE ALL ON FUNCTION miembro_programar_renovacion(boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION miembro_programar_renovacion(boolean, uuid) TO authenticated, service_role;

-- ── 7. FR-17 · Suscripción anterior tras una activación (webhook) ───────────
-- Una fila por suscripción anterior (la cancelación es terminal): los reintentos
-- del webhook convergen en la MISMA operación. Solo suscripciones que respaldan
-- (o respaldaron) una membresía de ESE miembro: nunca una ajena.
CREATE OR REPLACE FUNCTION registrar_cancelacion_suscripcion_anterior(
  p_usuario_id uuid, p_sub_anterior text, p_sub_nueva text, p_evento text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_m membresias;
  v_o stripe_operaciones_suscripcion;
  v_key text := 'cancelar_anterior:' || p_sub_anterior;
BEGIN
  IF p_sub_anterior IS NULL OR p_sub_anterior = '' OR p_sub_anterior IS NOT DISTINCT FROM p_sub_nueva THEN
    RAISE EXCEPTION 'EKKO_SUSCRIPCION_INVALIDA: La suscripción anterior no puede ser la nueva';
  END IF;
  SELECT * INTO v_m FROM membresias
  WHERE usuario_id = p_usuario_id AND stripe_subscription_id = p_sub_anterior
  ORDER BY created_at DESC LIMIT 1;
  IF v_m.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_SUSCRIPCION_AJENA: La suscripción no respalda ninguna membresía de este miembro';
  END IF;
  INSERT INTO stripe_operaciones_suscripcion (tenant_id, usuario_id, membresia_id, stripe_subscription_id, tipo, causa, operation_key, contexto)
  VALUES (v_m.tenant_id, p_usuario_id, v_m.id, p_sub_anterior, 'cancelar_suscripcion', 'suscripcion_anterior', v_key,
          jsonb_build_object('sub_nueva', p_sub_nueva, 'evento', p_evento))
  ON CONFLICT (operation_key) DO NOTHING;
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE operation_key = v_key;
  RETURN jsonb_build_object('id', v_o.id, 'estado', v_o.estado);
END;
$$;
REVOKE ALL ON FUNCTION registrar_cancelacion_suscripcion_anterior(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION registrar_cancelacion_suscripcion_anterior(uuid, text, text, text) TO service_role;

-- ── 8. v_pendientes_operativos (06G) con la rama de cobro ajustada ──────────
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
FROM resumen_fallos_push() f;

REVOKE ALL ON v_pendientes_operativos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON v_pendientes_operativos TO authenticated;
