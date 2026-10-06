-- ============================================================================
-- PKG-03A · PENDIENTES OPERATIVOS Y ENTREGA
-- ----------------------------------------------------------------------------
-- Auditoría de confiabilidad operativa (2026-10-05), F-2..F-6 y F-9:
--   · el correo fallido era terminal sin motivo ni reintento, y lo pendiente
--     >6 h se perdía en silencio; el push se marcaba "enviado" aunque fallara;
--   · los correos directos del webhook no dejaban evidencia;
--   · eventos de Stripe en `revision` y operaciones de cobro `fallida` no tenían
--     cierre humano ni superficie (solo un aviso en la campana: leído ≠ resuelto);
--   · las operaciones de cobro se reintentaban para siempre.
--
-- Principio: EVIDENCIA → CONDICIÓN DERIVADA → TRABAJO ACCIONABLE.
--   `notificaciones` sigue siendo el outbox de los avisos; `revisiones_financieras`,
--   `stripe_webhook_events` y `stripe_operaciones_suscripcion` siguen siendo la
--   autoridad de su dominio. `v_pendientes_operativos` solo deriva (no copia).
--   Sin tabla genérica de tareas, sin motor de flujos, sin reintentador genérico.
--
-- Aditiva: columnas, una tabla de evidencia (`correos_directos`), RPCs y una
-- vista. Sin UPDATE/DELETE de datos de negocio. Cambian de cuerpo, a propósito:
--   · `notificaciones_frontera_cliente` (02C): pasa de lista negra a lista blanca
--     (solo `leida`/`leida_at`) para cubrir las columnas nuevas y las futuras;
--   · `operacion_suscripcion_resultado` (R2-B): tope de reintentos automáticos.
-- D-03A-1 NO se implementa aquí (ver reporte: el modelo no distingue la pausa del
-- staff del eco de la suspensión por sanción).
-- Pruebas: src/__tests__/db/03a-pendientes-operativos.db.test.ts · hardening §P5
-- ============================================================================

-- ── 1. Avisos: ciclo de vida de la entrega ───────────────────────────────────
ALTER TABLE notificaciones
  ADD COLUMN IF NOT EXISTS email_intentos     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_ultimo_error text,
  ADD COLUMN IF NOT EXISTS email_siguiente_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_revisado_at  timestamptz,
  ADD COLUMN IF NOT EXISTS email_revisado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS push_resultado     text,
  ADD COLUMN IF NOT EXISTS push_intento_at    timestamptz;

ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_email_intentos_check;
ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_email_intentos_check CHECK (email_intentos >= 0);

-- `reintentable` = falló algo transitorio y hay otro intento programado
-- (`email_siguiente_at`). `fallo` sigue siendo terminal.
ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_email_resultado_check;
ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_email_resultado_check
  CHECK (email_resultado IS NULL OR email_resultado IN ('aceptado', 'sin_correo', 'fallo', 'reintentable'));

-- Push con resultado explícito. `push_enviado_at` vuelve a significar ENVIADO:
-- solo existe con `enviado` (las filas anteriores a 03A conservan su marca sin
-- resultado: histórico "procesado", no se reinterpreta).
ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_push_resultado_check;
ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_push_resultado_check
  CHECK (push_resultado IS NULL OR push_resultado IN ('enviado', 'sin_suscripcion', 'fallo', 'sin_config'));
ALTER TABLE notificaciones DROP CONSTRAINT IF EXISTS notificaciones_push_enviado_check;
ALTER TABLE notificaciones ADD CONSTRAINT notificaciones_push_enviado_check
  CHECK ((push_resultado IS DISTINCT FROM 'enviado' OR push_enviado_at IS NOT NULL)
         AND (push_resultado IS NULL OR push_resultado = 'enviado' OR push_enviado_at IS NULL));

COMMENT ON COLUMN notificaciones.email_intentos IS 'PKG-03A: intentos de envío por correo (máx. 3).';
COMMENT ON COLUMN notificaciones.email_siguiente_at IS 'PKG-03A: próximo intento (backoff) o fin del lease del intento en curso.';
COMMENT ON COLUMN notificaciones.push_resultado IS 'PKG-03A: enviado | sin_suscripcion | fallo | sin_config. NULL = pendiente o histórico anterior a 03A.';

CREATE INDEX IF NOT EXISTS notificaciones_email_fallo_idx
  ON notificaciones (tenant_id, creada_at) WHERE email_resultado = 'fallo' AND email_revisado_at IS NULL;

-- 02C, ahora por LISTA BLANCA: desde el cliente solo cambian `leida`/`leida_at`.
-- (Antes enumeraba las columnas protegidas; las de 03A habrían quedado abiertas.)
CREATE OR REPLACE FUNCTION notificaciones_frontera_cliente()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;  -- service_role, triggers y crons: sin restricción
  END IF;

  IF (to_jsonb(NEW) - 'leida' - 'leida_at') IS DISTINCT FROM (to_jsonb(OLD) - 'leida' - 'leida_at') THEN
    RAISE EXCEPTION 'EKKO_AVISO_SOLO_LECTURA: Un aviso solo se marca como leído; su contenido y su evidencia de envío son del servidor';
  END IF;

  -- El aviso de cambio de contraseña lo cierra el servidor (on_auth_user_password_changed).
  IF OLD.tipo = 'cambiar_password' THEN
    NEW.leida := OLD.leida;
    NEW.leida_at := OLD.leida_at;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION notificaciones_frontera_cliente() FROM PUBLIC, anon, authenticated;

-- El cron toma lo que toca enviar. Toma = intento: se cuenta al reclamar y se fija
-- un lease (`email_siguiente_at`) para que dos corridas no lo pisen. Lo que nunca
-- se intentó y ya salió de la ventana NO se pierde en silencio: queda `fallo`
-- (`ventana_vencida`), visible en pendientes. Solo últimos 7 días (no se
-- reinterpreta historia anterior a 03A).
CREATE OR REPLACE FUNCTION reclamar_correos_pendientes(p_tipos text[], p_limite integer DEFAULT 50, p_ventana interval DEFAULT interval '6 hours')
RETURNS TABLE (id uuid, tenant_id uuid, usuario_id uuid, tipo text, titulo text, mensaje text, metadata jsonb, email_intentos integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notificaciones n
  SET email_resultado = 'fallo', email_ultimo_error = 'ventana_vencida', email_siguiente_at = NULL
  WHERE n.tipo = ANY (p_tipos) AND n.email_enviado_at IS NULL AND n.email_resultado IS NULL
    AND n.email_intentos = 0 AND n.email_siguiente_at IS NULL
    AND n.creada_at < now() - p_ventana AND n.creada_at >= now() - interval '7 days';

  -- Lease vencido con los intentos agotados (la corrida murió en el tercero).
  UPDATE notificaciones n
  SET email_resultado = 'fallo', email_ultimo_error = COALESCE(n.email_ultimo_error, 'intentos_agotados'), email_siguiente_at = NULL
  WHERE n.tipo = ANY (p_tipos) AND n.email_enviado_at IS NULL
    AND (n.email_resultado IS NULL OR n.email_resultado = 'reintentable')
    AND n.email_intentos >= 3 AND n.email_siguiente_at <= now();

  RETURN QUERY
  UPDATE notificaciones n
  SET email_intentos = n.email_intentos + 1, email_siguiente_at = now() + interval '10 minutes'
  WHERE n.id IN (
    SELECT x.id FROM notificaciones x
    WHERE x.tipo = ANY (p_tipos) AND x.email_enviado_at IS NULL AND x.email_intentos < 3
      AND (
        (x.email_resultado IS NULL AND x.email_intentos = 0 AND x.email_siguiente_at IS NULL AND x.creada_at >= now() - p_ventana)
        OR ((x.email_resultado IS NULL OR x.email_resultado = 'reintentable') AND x.email_siguiente_at <= now())
      )
    ORDER BY x.creada_at
    LIMIT p_limite
    FOR UPDATE SKIP LOCKED)
  RETURNING n.id, n.tenant_id, n.usuario_id, n.tipo, n.titulo, n.mensaje, n.metadata, n.email_intentos;
END;
$$;
REVOKE ALL ON FUNCTION reclamar_correos_pendientes(text[], integer, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reclamar_correos_pendientes(text[], integer, interval) TO service_role;

-- Resultado de UN intento. Transitorio (timeout/red/5xx/429) y quedan intentos →
-- `reintentable` con backoff (2 min, luego 10 min). Si no → terminal.
-- `aceptado` exige id del proveedor (aceptado ≠ entregado, EKKO-111).
CREATE OR REPLACE FUNCTION notificacion_email_resultado(p_id uuid, p_resultado text, p_proveedor_id text, p_error text, p_reintentable boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n notificaciones;
  v_error text := left(NULLIF(trim(COALESCE(p_error, '')), ''), 200);
BEGIN
  IF p_resultado NOT IN ('aceptado', 'sin_correo', 'fallo') THEN
    RAISE EXCEPTION 'EKKO_RESULTADO_INVALIDO: %', p_resultado;
  END IF;
  SELECT * INTO v_n FROM notificaciones WHERE id = p_id FOR UPDATE;
  IF v_n.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_AVISO_NO_EXISTE: Aviso no encontrado';
  END IF;
  -- Idempotente: lo ya resuelto no cambia (p. ej. un intento tardío tras otro aceptado).
  IF v_n.email_enviado_at IS NOT NULL OR v_n.email_resultado IN ('aceptado', 'sin_correo', 'fallo') THEN
    RETURN jsonb_build_object('estado', v_n.email_resultado, 'idempotente', true);
  END IF;

  IF p_resultado = 'aceptado' AND NULLIF(trim(COALESCE(p_proveedor_id, '')), '') IS NOT NULL THEN
    UPDATE notificaciones
    SET email_resultado = 'aceptado', email_proveedor_id = trim(p_proveedor_id), email_enviado_at = now(),
        email_ultimo_error = NULL, email_siguiente_at = NULL
    WHERE id = p_id;
    RETURN jsonb_build_object('estado', 'aceptado', 'idempotente', false);
  ELSIF p_resultado = 'sin_correo' THEN
    UPDATE notificaciones SET email_resultado = 'sin_correo', email_siguiente_at = NULL WHERE id = p_id;
    RETURN jsonb_build_object('estado', 'sin_correo', 'idempotente', false);
  END IF;

  -- fallo (o "aceptado" sin id: sin evidencia de aceptación no hay éxito)
  v_error := COALESCE(v_error, CASE WHEN p_resultado = 'aceptado' THEN 'aceptado_sin_id' ELSE 'error_desconocido' END);
  IF COALESCE(p_reintentable, false) AND v_n.email_intentos < 3 THEN
    UPDATE notificaciones
    SET email_resultado = 'reintentable', email_ultimo_error = v_error,
        email_siguiente_at = now() + CASE WHEN v_n.email_intentos <= 1 THEN interval '2 minutes' ELSE interval '10 minutes' END
    WHERE id = p_id;
    RETURN jsonb_build_object('estado', 'reintentable', 'idempotente', false);
  END IF;
  UPDATE notificaciones
  SET email_resultado = 'fallo', email_ultimo_error = v_error, email_siguiente_at = NULL
  WHERE id = p_id;
  RETURN jsonb_build_object('estado', 'fallo', 'idempotente', false);
END;
$$;
REVOKE ALL ON FUNCTION notificacion_email_resultado(uuid, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION notificacion_email_resultado(uuid, text, text, text, boolean) TO service_role;

-- Push: reclamar con lease (dos corridas o un envío directo no duplican) y
-- asentar el resultado DESPUÉS de enviar. Lo de >24 h ya no es aviso: no se toma.
CREATE OR REPLACE FUNCTION reclamar_push_pendientes(p_limite integer DEFAULT 200)
RETURNS TABLE (id uuid, usuario_id uuid, tipo text, titulo text, mensaje text, metadata jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  UPDATE notificaciones n
  SET push_intento_at = now()
  WHERE n.id IN (
    SELECT x.id FROM notificaciones x
    WHERE x.push_resultado IS NULL AND x.push_enviado_at IS NULL
      AND (x.push_intento_at IS NULL OR x.push_intento_at < now() - interval '5 minutes')
      AND x.creada_at >= now() - interval '24 hours'
    ORDER BY x.creada_at
    LIMIT p_limite
    FOR UPDATE SKIP LOCKED)
  RETURNING n.id, n.usuario_id, n.tipo, n.titulo, n.mensaje, n.metadata;
END;
$$;
REVOKE ALL ON FUNCTION reclamar_push_pendientes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reclamar_push_pendientes(integer) TO service_role;

CREATE OR REPLACE FUNCTION registrar_resultado_push(p_ids uuid[], p_resultado text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_resultado NOT IN ('enviado', 'sin_suscripcion', 'fallo', 'sin_config') THEN
    RAISE EXCEPTION 'EKKO_RESULTADO_INVALIDO: %', p_resultado;
  END IF;
  UPDATE notificaciones
  SET push_resultado = p_resultado,
      push_enviado_at = CASE WHEN p_resultado = 'enviado' THEN now() END
  WHERE id = ANY (p_ids) AND push_resultado IS NULL AND push_enviado_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION registrar_resultado_push(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION registrar_resultado_push(uuid[], text) TO service_role;

-- ── 2. Correos directos del webhook: evidencia mínima ────────────────────────
-- Bienvenida, recibo, pago fallido, paquete: salen del webhook (llevan el monto)
-- y NO son avisos de la campana. Identidad = la Idempotency-Key que ya se manda a
-- Resend. Sin destinatario, sin cuerpo, sin payload de Stripe.
CREATE TABLE IF NOT EXISTS correos_directos (
  idempotency_key    text PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  usuario_id         uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  plantilla          text NOT NULL CHECK (plantilla IN ('pago_fallido', 'bienvenida', 'recibo', 'paquete_comprado')),
  stripe_event_id    text NOT NULL,
  resultado          text NOT NULL CHECK (resultado IN ('aceptado', 'sin_correo', 'fallo')),
  proveedor_id       text,
  ultimo_error       text,
  intentos           integer NOT NULL DEFAULT 1 CHECK (intentos >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  ultimo_intento_at  timestamptz NOT NULL DEFAULT now(),
  enviado_at         timestamptz,
  revisado_at        timestamptz,
  revisado_por       uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  CHECK (resultado <> 'aceptado' OR (proveedor_id IS NOT NULL AND enviado_at IS NOT NULL)),
  CHECK (resultado = 'aceptado' OR (proveedor_id IS NULL AND enviado_at IS NULL))
);
CREATE INDEX IF NOT EXISTS correos_directos_fallo_idx
  ON correos_directos (tenant_id, created_at) WHERE resultado = 'fallo' AND revisado_at IS NULL;
COMMENT ON TABLE correos_directos IS
  'PKG-03A: evidencia de los correos que el webhook de Stripe manda directo (no son avisos). aceptado = Resend aceptó (≠ entregado).';
ALTER TABLE correos_directos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS correos_directos_admin_read ON correos_directos;
CREATE POLICY correos_directos_admin_read ON correos_directos
  FOR SELECT TO authenticated USING (tenant_id = get_my_tenant_id() AND is_admin());
REVOKE ALL ON correos_directos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON correos_directos TO authenticated;

-- Idempotente por llave: un reintento suma intento; lo aceptado no se degrada.
CREATE OR REPLACE FUNCTION registrar_correo_directo(
  p_key text, p_tenant_id uuid, p_usuario_id uuid, p_plantilla text, p_stripe_event_id text,
  p_resultado text, p_proveedor_id text, p_error text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res text := CASE WHEN p_resultado = 'aceptado' AND NULLIF(trim(COALESCE(p_proveedor_id, '')), '') IS NULL
                     THEN 'fallo' ELSE p_resultado END;
  v_final text;
BEGIN
  INSERT INTO correos_directos AS c (idempotency_key, tenant_id, usuario_id, plantilla, stripe_event_id,
                                     resultado, proveedor_id, ultimo_error, enviado_at)
  VALUES (p_key, p_tenant_id, p_usuario_id, p_plantilla, p_stripe_event_id, v_res,
          CASE WHEN v_res = 'aceptado' THEN trim(p_proveedor_id) END,
          CASE WHEN v_res = 'fallo' THEN left(COALESCE(NULLIF(trim(COALESCE(p_error, '')), ''), 'error_desconocido'), 200) END,
          CASE WHEN v_res = 'aceptado' THEN now() END)
  ON CONFLICT (idempotency_key) DO UPDATE
    SET intentos = c.intentos + 1, ultimo_intento_at = now(),
        resultado = EXCLUDED.resultado, proveedor_id = EXCLUDED.proveedor_id,
        ultimo_error = EXCLUDED.ultimo_error, enviado_at = EXCLUDED.enviado_at
    WHERE c.resultado <> 'aceptado';
  SELECT resultado INTO v_final FROM correos_directos WHERE idempotency_key = p_key;
  RETURN v_final;
END;
$$;
REVOKE ALL ON FUNCTION registrar_correo_directo(text, uuid, uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION registrar_correo_directo(text, uuid, uuid, text, text, text, text, text) TO service_role;

-- Un fallo de entrega (correo de aviso o correo directo) se da por atendido
-- explícitamente: leído ≠ resuelto. Documenta; no reenvía nada.
CREATE OR REPLACE FUNCTION resolver_fallo_entrega(p_fuente text, p_id text, p_nota text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_rol text := get_my_rol();
  v_ya timestamptz;
  v_tipo text;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede atender fallos de entrega';
  END IF;
  IF COALESCE(length(trim(p_nota)), 0) < 10 THEN
    RAISE EXCEPTION 'EKKO_NOTA_REQUERIDA: Explica qué se hizo (mínimo 10 caracteres)';
  END IF;

  IF p_fuente = 'notificaciones' THEN
    SELECT email_revisado_at, tipo INTO v_ya, v_tipo FROM notificaciones
    WHERE id = p_id::uuid AND tenant_id = v_tenant AND email_resultado = 'fallo' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'EKKO_FALLO_INVALIDO: No hay un correo fallido con ese id en tu estudio';
    END IF;
    IF v_ya IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'idempotente', true);
    END IF;
    UPDATE notificaciones SET email_revisado_at = now(), email_revisado_por = v_actor WHERE id = p_id::uuid;
  ELSIF p_fuente = 'correos_directos' THEN
    SELECT revisado_at, plantilla INTO v_ya, v_tipo FROM correos_directos
    WHERE idempotency_key = p_id AND tenant_id = v_tenant AND resultado = 'fallo' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'EKKO_FALLO_INVALIDO: No hay un correo fallido con ese id en tu estudio';
    END IF;
    IF v_ya IS NOT NULL THEN
      RETURN jsonb_build_object('success', true, 'idempotente', true);
    END IF;
    UPDATE correos_directos SET revisado_at = now(), revisado_por = v_actor WHERE idempotency_key = p_id;
  ELSE
    RAISE EXCEPTION 'EKKO_FUENTE_INVALIDA: %', p_fuente;
  END IF;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'fallo_entrega_atendido', p_fuente, md5(p_fuente || ':' || p_id)::uuid,
          jsonb_build_object('resultado', 'fallo'), jsonb_build_object('atendido', true),
          trim(p_nota), jsonb_build_object('fuente', p_fuente, 'id', p_id, 'tipo', v_tipo));
  RETURN jsonb_build_object('success', true, 'idempotente', false);
END;
$$;
REVOKE ALL ON FUNCTION resolver_fallo_entrega(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolver_fallo_entrega(text, text, text) TO authenticated;

-- El admin ve los avisos cuyo correo falló en su estudio (para atenderlos).
DROP POLICY IF EXISTS "Notificaciones: admin ve correos fallidos de su estudio" ON notificaciones;
CREATE POLICY "Notificaciones: admin ve correos fallidos de su estudio" ON notificaciones
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin() AND email_resultado = 'fallo');

-- ── 3. Eventos de Stripe: cierre humano ──────────────────────────────────────
-- El evento sigue siendo la evidencia: no se borra ni se reescribe su estado.
-- Revisarlo NO afirma que el efecto ocurrió; documenta qué hizo el estudio.
ALTER TABLE stripe_webhook_events
  ADD COLUMN IF NOT EXISTS revisado_at   timestamptz,
  ADD COLUMN IF NOT EXISTS revisado_por  uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolucion    text,
  ADD COLUMN IF NOT EXISTS nota_revision text;
ALTER TABLE stripe_webhook_events DROP CONSTRAINT IF EXISTS stripe_webhook_events_resolucion_check;
ALTER TABLE stripe_webhook_events ADD CONSTRAINT stripe_webhook_events_resolucion_check
  CHECK ((resolucion IS NULL AND revisado_at IS NULL)
         OR (resolucion IN ('reenviado_desde_stripe', 'sin_efecto', 'ajuste_manual_registrado', 'otro')
             AND revisado_at IS NOT NULL AND nota_revision IS NOT NULL));

-- La cuenta conectada del estudio de la sesión (solo admin). `authenticated` no
-- lee `tenants.stripe_account_id` por columna; esto lo expone solo para derivar
-- el tenant de un evento, nunca para escribir.
CREATE OR REPLACE FUNCTION _mi_cuenta_stripe()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.stripe_account_id FROM tenants t
  WHERE t.id = get_my_tenant_id() AND is_admin() AND t.stripe_account_id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION _mi_cuenta_stripe() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _mi_cuenta_stripe() TO authenticated;

DROP POLICY IF EXISTS stripe_webhook_events_admin_read ON stripe_webhook_events;
CREATE POLICY stripe_webhook_events_admin_read ON stripe_webhook_events
  FOR SELECT TO authenticated
  USING (stripe_account IS NOT NULL AND stripe_account = _mi_cuenta_stripe());

CREATE OR REPLACE FUNCTION resolver_evento_stripe(p_evento_id text, p_resolucion text, p_nota text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := get_my_user_id();
  v_tenant uuid := get_my_tenant_id();
  v_rol text := get_my_rol();
  v_cuenta text;
  v_e stripe_webhook_events;
BEGIN
  IF v_actor IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede resolver eventos de Stripe';
  END IF;
  IF p_resolucion NOT IN ('reenviado_desde_stripe', 'sin_efecto', 'ajuste_manual_registrado', 'otro') THEN
    RAISE EXCEPTION 'EKKO_RESOLUCION_INVALIDA: resolución % no permitida', p_resolucion;
  END IF;
  IF COALESCE(length(trim(p_nota)), 0) < 10 THEN
    RAISE EXCEPTION 'EKKO_NOTA_REQUERIDA: Explica la resolución (mínimo 10 caracteres)';
  END IF;
  SELECT stripe_account_id INTO v_cuenta FROM tenants WHERE id = v_tenant;
  SELECT * INTO v_e FROM stripe_webhook_events
  WHERE id = p_evento_id AND stripe_account IS NOT NULL AND stripe_account = v_cuenta FOR UPDATE;
  IF v_e.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_EVENTO_INVALIDO: Evento no encontrado o de otro estudio';
  END IF;
  -- Ya revisado después de su último intento: idempotente si es la misma resolución.
  IF v_e.revisado_at IS NOT NULL AND v_e.revisado_at >= COALESCE(v_e.ultimo_intento_at, v_e.received_at) THEN
    IF v_e.resolucion = p_resolucion THEN
      RETURN jsonb_build_object('success', true, 'idempotente', true);
    END IF;
    RAISE EXCEPTION 'EKKO_EVENTO_RESUELTO: Ya está resuelto como %', v_e.resolucion;
  END IF;
  IF NOT (v_e.estado IN ('revision', 'error_reintentable')
          OR (v_e.estado = 'en_proceso' AND v_e.lease_hasta < now())) THEN
    RAISE EXCEPTION 'EKKO_EVENTO_SIN_PENDIENTE: El evento está %; no requiere resolución', v_e.estado;
  END IF;

  UPDATE stripe_webhook_events
  SET revisado_at = now(), revisado_por = v_actor, resolucion = p_resolucion, nota_revision = trim(p_nota)
  WHERE id = v_e.id;
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'evento_stripe_resuelto', 'evento_stripe', md5('evento_stripe:' || v_e.id)::uuid,
          jsonb_build_object('estado', v_e.estado, 'motivo', v_e.motivo),
          jsonb_build_object('resolucion', p_resolucion),
          trim(p_nota), jsonb_build_object('evento_id', v_e.id, 'type', v_e.type, 'intentos', v_e.intentos));
  RETURN jsonb_build_object('success', true, 'idempotente', false);
END;
$$;
REVOKE ALL ON FUNCTION resolver_evento_stripe(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolver_evento_stripe(text, text, text) TO authenticated;

-- ── 4. Operaciones de cobro: tope de reintentos y cierre humano ──────────────
-- Tope: 5 intentos automáticos por ronda. Agotada = sigue `fallida` (los
-- triggers de sanción/revocación la siguen viendo y descartando igual) pero el
-- ejecutor ya no la toma: necesita a un humano. Reintentar abre una ronda nueva
-- sobre la MISMA fila y la misma operation_key: nunca una segunda operación.
ALTER TABLE stripe_operaciones_suscripcion
  ADD COLUMN IF NOT EXISTS intentos_ronda_base     integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reintentos_agotados_at  timestamptz,
  ADD COLUMN IF NOT EXISTS revisada_at             timestamptz,
  ADD COLUMN IF NOT EXISTS revisada_por            uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS nota_revision           text;
ALTER TABLE stripe_operaciones_suscripcion DROP CONSTRAINT IF EXISTS stripe_operaciones_suscripcion_ronda_check;
ALTER TABLE stripe_operaciones_suscripcion ADD CONSTRAINT stripe_operaciones_suscripcion_ronda_check
  CHECK (intentos_ronda_base >= 0 AND intentos_ronda_base <= intentos);

-- R2-B, misma definición más el tope (marcado PKG-03A).
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
      'Stripe no aplicó un cambio de cobro',
      CASE v_o.tipo
        WHEN 'suspender_cobro' THEN 'No se pudo SUSPENDER el cobro de un miembro sancionado. La sanción sigue vigente; el cobro se reintentará.'
        WHEN 'reanudar_cobro' THEN 'No se pudo REANUDAR el cobro de un miembro al que se le levantó la sanción. Se reintentará.'
        ELSE 'No se pudo CANCELAR en Stripe la suscripción de una cuenta dada de baja o revocada. El acceso sigue bloqueado; se reintentará.'
      END,
      jsonb_build_object('operacion_id', v_o.id, 'tipo', v_o.tipo, 'causa', v_o.causa,
                         'usuario_id', v_o.usuario_id, 'url', '/admin/miembros/' || COALESCE(v_o.usuario_id::text, '')));
  END IF;
  RETURN jsonb_build_object('success', true, 'estado', 'fallida', 'agotada', v_o.reintentos_agotados_at IS NOT NULL);
END;
$$;
REVOKE ALL ON FUNCTION operacion_suscripcion_resultado(uuid, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION operacion_suscripcion_resultado(uuid, boolean, text, jsonb) TO service_role;

-- Reintentar: ronda nueva sobre la misma fila. El ejecutor (cron diario o
-- "sincronizar cobro") la toma; `operacion_suscripcion_preparar` la revalida.
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
REVOKE ALL ON FUNCTION staff_reintentar_operacion_cobro(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_reintentar_operacion_cobro(uuid, text) TO authenticated;

-- Descartar: el admin decide que EKKO ya no debe aplicarla (p. ej. lo resolvió en
-- el panel de Stripe). Queda escrito quién, cuándo y por qué. Lo aplicado no cambia.
CREATE OR REPLACE FUNCTION staff_descartar_operacion_cobro(p_operacion_id uuid, p_nota text)
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
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede descartar operaciones de cobro';
  END IF;
  IF COALESCE(length(trim(p_nota)), 0) < 10 THEN
    RAISE EXCEPTION 'EKKO_NOTA_REQUERIDA: Explica por qué se descarta (mínimo 10 caracteres)';
  END IF;
  SELECT * INTO v_o FROM stripe_operaciones_suscripcion WHERE id = p_operacion_id AND tenant_id = v_tenant FOR UPDATE;
  IF v_o.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_OPERACION_INVALIDA: Operación no encontrada o de otro estudio';
  END IF;
  IF v_o.estado = 'descartada' THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'estado', 'descartada');
  END IF;
  IF v_o.estado = 'aplicada' THEN
    RAISE EXCEPTION 'EKKO_OPERACION_CERRADA: La operación ya se aplicó en Stripe';
  END IF;

  UPDATE stripe_operaciones_suscripcion
  SET estado = 'descartada', motivo_descarte = 'descartada_por_admin', reintentos_agotados_at = NULL,
      revisada_at = now(), revisada_por = v_actor, nota_revision = trim(p_nota)
  WHERE id = v_o.id;
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_tenant, v_actor, v_rol, 'operacion_cobro_descartada', 'operacion_cobro', v_o.id,
          jsonb_build_object('estado', v_o.estado, 'intentos', v_o.intentos),
          jsonb_build_object('estado', 'descartada'),
          trim(p_nota), jsonb_build_object('tipo', v_o.tipo, 'causa', v_o.causa, 'usuario_id', v_o.usuario_id));
  RETURN jsonb_build_object('success', true, 'idempotente', false, 'estado', 'descartada');
END;
$$;
REVOKE ALL ON FUNCTION staff_descartar_operacion_cobro(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_descartar_operacion_cobro(uuid, text) TO authenticated;

-- ── 5. Vista derivada de pendientes operativos ───────────────────────────────
-- Solo deriva de las autoridades. security_invoker: manda la RLS de cada fuente
-- (todas admin de su tenant); además, cada rama exige is_admin() y el tenant de
-- la sesión. Divergencias: solo las que significan derecho o cobro inconsistente
-- (las de caché de display no son accionables, EKKO-123).
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
                   'varias_membresias_vivas', 'stripe_contradictorio', 'stripe_customer_distinto');

COMMENT ON VIEW v_pendientes_operativos IS
  'PKG-03A: trabajo operativo DERIVADO de sus autoridades (revisiones, eventos de Stripe, operaciones de cobro, fallos de entrega, divergencias). No copia datos. Admin de su estudio.';
REVOKE ALL ON v_pendientes_operativos FROM PUBLIC, anon, authenticated;
GRANT SELECT ON v_pendientes_operativos TO authenticated;
