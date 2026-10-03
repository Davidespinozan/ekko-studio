-- ============================================================================
-- R2-A · INTEGRIDAD DE RESERVAS, ASISTENCIA Y AUTORIDAD (PKG-01I/01J/01K/01L/01M)
-- ----------------------------------------------------------------------------
-- Un solo modelo de servidor para las transiciones de reserva:
--
--  01I · Transiciones de asistencia por RPC (`staff_corregir_asistencia`):
--        · "Sí asistió" SOLO desde no_show (antes también revivía cancelada /
--          cancelada_admin → sesión gratis, saltando identidad y membresía).
--        · "Deshacer check-in" SOLO desde completada, el mismo día.
--        · Penalización revertida en la misma transacción, con la fila del
--          miembro bloqueada (antes: read-modify-write sin lock desde Netlify).
--        · La guarda de identidad aplica a CUALQUIER entrada a completada.
--        · cron de no-show y cancelación: transiciones condicionadas / FOR UPDATE.
--  01J · `reprogramar_reserva`: cancelar la vieja + crear la nueva + mover
--        invitados (fichas y extras pagados, con traslado trazable) + aviso +
--        auditoría, en UNA transacción. Si algo falla, la original queda intacta.
--        La evidencia de 01H no se reescribe: el traslado es una fila nueva.
--  01K · El plan que da derechos sale de la membresía VIVA (`_tier_vivo`), no
--        del slug cacheado usuarios.membresia_tier (que queda como display).
--  01L · Fin del FOR ALL de admin en reservas, membresias y datos privados; el
--        admin no muta por REST los campos de estado de negocio de usuarios.
--  01M · Planes: slug inmutable; tipo y "activo" no cambian con membresías vivas;
--        reglas.max_invitados obligatorio (sin defaults legados por slug).
--
-- Aditiva: sin UPDATE/DELETE de datos de negocio, sin backfill. No reescribe
-- funciones R1 (activar_membresia, sync_membresia_stripe, bloqueo de revocado,
-- sanción, _estado_membresia_checkin) ni 01A–01G. Toca 01H solo en el SUM
-- canónico de `aplicar_invitados_extra_pago`, que pasa a contar los traslados
-- (sin traslados es idéntico a 01H).
-- ============================================================================

-- ── 0. Plan VIVO de un usuario (fuente de verdad de derechos) ────────────────
CREATE OR REPLACE FUNCTION _tier_vivo(p_usuario_id uuid)
RETURNS tiers
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.*
  FROM membresias m
  JOIN tiers t ON t.id = m.tier_id
  WHERE m.usuario_id = p_usuario_id
    -- Mismo conjunto y orden que creditos_debitar_al_reservar: el plan que da
    -- derechos es el de la membresía que paga la reserva.
    AND m.status IN ('trialing', 'activa', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION _tier_vivo(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN usuarios.membresia_tier IS
  'CACHÉ DE DISPLAY (R2-A/01K): slug del plan vivo o del plan elegido al registrarse. No decide derechos: las RPC usan _tier_vivo(). Divergencias: v_reconciliacion_membresia.';

-- ── 1. Planes (01M) ──────────────────────────────────────────────────────────
-- Un plan creado sin reglas nace con 0 invitados EXPLÍCITO (lo más restrictivo),
-- no con '{}' + fallback por slug en las RPC.
ALTER TABLE tiers ALTER COLUMN reglas SET DEFAULT '{"max_invitados": 0}'::jsonb;
ALTER TABLE tiers
  ADD CONSTRAINT tiers_max_invitados_obligatorio
  -- CASE (no AND): un CHECK que evalúa a NULL se ACEPTA; sin la clave, o con
  -- reglas NULL, jsonb_typeof es NULL y el plan pasaría. Entero ≥ 0.
  CHECK (CASE WHEN jsonb_typeof(reglas->'max_invitados') = 'number'
              THEN (reglas->>'max_invitados')::numeric >= 0
               AND (reglas->>'max_invitados')::numeric = trunc((reglas->>'max_invitados')::numeric)
              ELSE false END) NOT VALID;
ALTER TABLE tiers VALIDATE CONSTRAINT tiers_max_invitados_obligatorio;

CREATE OR REPLACE FUNCTION tiers_proteger_semantica()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vivas integer;
BEGIN
  -- El slug es identidad: lo guardan recursos.tiers_permitidos, el caché de
  -- usuarios, URLs de alta y auditoría. No se renombra.
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'EKKO_TIER_SLUG_INMUTABLE: El identificador del plan no se puede cambiar; crea un plan nuevo';
  END IF;
  -- tipo (tiempo/creditos/hibrido) se lee EN VIVO al reservar: cambiarlo con
  -- membresías vivas reinterpreta sus derechos. Desactivar el plan lo saca de
  -- tiers_permitidos y bloquea renovaciones/activaciones.
  IF NEW.tipo IS DISTINCT FROM OLD.tipo OR (OLD.activo AND NOT NEW.activo) THEN
    SELECT count(*) INTO v_vivas FROM membresias
    WHERE tier_id = OLD.id AND status IN ('trialing', 'activa', 'past_due', 'pausada');
    IF v_vivas > 0 THEN
      RAISE EXCEPTION 'EKKO_TIER_EN_USO: % membresía(s) viva(s) usan este plan. Para dejar de venderlo usa "en venta"; para cambiar su tipo, crea un plan nuevo', v_vivas;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION tiers_proteger_semantica() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_tiers_proteger_semantica ON tiers;
CREATE TRIGGER trg_tiers_proteger_semantica
  BEFORE UPDATE ON tiers
  FOR EACH ROW EXECUTE FUNCTION tiers_proteger_semantica();

-- ── 2. Reprogramación: enlace y traslado trazable de extras pagados (01J) ────
ALTER TABLE reservas ADD COLUMN IF NOT EXISTS reprogramada_desde uuid REFERENCES reservas(id) ON DELETE SET NULL;
COMMENT ON COLUMN reservas.reprogramada_desde IS 'R2-A: reserva original cuando esta nació de una reprogramación atómica.';

CREATE TABLE IF NOT EXISTS invitados_extra_traslados (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                 bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pago_id             uuid NOT NULL REFERENCES invitados_extra_pagos(id) ON DELETE RESTRICT,
  reserva_origen_id   uuid NOT NULL REFERENCES reservas(id) ON DELETE RESTRICT,
  reserva_destino_id  uuid NOT NULL REFERENCES reservas(id) ON DELETE RESTRICT,
  cantidad            integer NOT NULL CHECK (cantidad > 0),
  actor_usuario_id    uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (reserva_origen_id <> reserva_destino_id)
);
CREATE INDEX IF NOT EXISTS invitados_extra_traslados_pago_idx ON invitados_extra_traslados (pago_id, seq DESC);
CREATE INDEX IF NOT EXISTS invitados_extra_traslados_destino_idx ON invitados_extra_traslados (reserva_destino_id);
COMMENT ON TABLE invitados_extra_traslados IS
  'R2-A/01J: a qué reserva quedó atribuido un pago de invitados extra tras reprogramar. La evidencia del pago (invitados_extra_pagos) no se toca.';

CREATE OR REPLACE FUNCTION invitados_extra_traslados_inmutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'EKKO_TRASLADO_INMUTABLE: Un traslado de invitados extra no se modifica ni se borra';
END;
$$;
REVOKE ALL ON FUNCTION invitados_extra_traslados_inmutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_invitados_extra_traslados_inmutable ON invitados_extra_traslados;
CREATE TRIGGER trg_invitados_extra_traslados_inmutable
  BEFORE UPDATE OR DELETE ON invitados_extra_traslados
  FOR EACH ROW EXECUTE FUNCTION invitados_extra_traslados_inmutable();
ALTER TABLE invitados_extra_traslados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invitados_extra_traslados_admin_read ON invitados_extra_traslados;
CREATE POLICY invitados_extra_traslados_admin_read ON invitados_extra_traslados
  FOR SELECT TO authenticated USING (tenant_id = get_my_tenant_id() AND is_admin());

-- Pagos aplicados atribuidos HOY a una reserva: el destino del último traslado
-- del pago, o su reserva original si nunca se trasladó.
CREATE OR REPLACE FUNCTION _extras_atribuidos(p_reserva_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cand AS (
    SELECT id FROM invitados_extra_pagos WHERE reserva_id = p_reserva_id AND estado = 'aplicado'
    UNION
    SELECT pago_id FROM invitados_extra_traslados WHERE reserva_destino_id = p_reserva_id
  )
  SELECT COALESCE(SUM(p.cantidad), 0)::integer
  FROM invitados_extra_pagos p
  JOIN cand ON cand.id = p.id
  WHERE p.estado = 'aplicado'
    AND COALESCE(
          (SELECT t.reserva_destino_id FROM invitados_extra_traslados t
           WHERE t.pago_id = p.id ORDER BY t.seq DESC LIMIT 1),
          p.reserva_id
        ) = p_reserva_id;
$$;
REVOKE ALL ON FUNCTION _extras_atribuidos(uuid) FROM PUBLIC, anon, authenticated;

-- ── 3. Funciones existentes reescritas (cuerpos copiados de su última versión,
--       con los cambios marcados "R2-A") ─────────────────────────────────────
CREATE OR REPLACE FUNCTION exigir_identidad_al_ingresar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_completa boolean;
  v_contrato boolean;
BEGIN
  -- R2-A (01I): cualquier ENTRADA a completada (check-in o corrección de
  -- asistencia), no solo desde confirmada.
  IF NOT (NEW.status = 'completada' AND OLD.status IS DISTINCT FROM 'completada') THEN
    RETURN NEW;
  END IF;

  SELECT identidad_completa, contrato_firmado
    INTO v_completa, v_contrato
  FROM usuarios WHERE id = NEW.usuario_id;

  IF NOT COALESCE(v_completa, false) THEN
    RAISE EXCEPTION 'EKKO_IDENTIDAD_INCOMPLETA: Falta capturar la ficha de identidad (foto, datos, INE) antes de dar ingreso.';
  END IF;
  IF NOT COALESCE(v_contrato, false) THEN
    RAISE EXCEPTION 'EKKO_CONTRATO_PENDIENTE: El miembro debe firmar el contrato antes de dar ingreso.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION proteger_columnas_privilegiadas_usuarios()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND NOT is_admin() THEN
    IF NEW.rol                 IS DISTINCT FROM OLD.rol
    OR NEW.tenant_id           IS DISTINCT FROM OLD.tenant_id
    OR NEW.status              IS DISTINCT FROM OLD.status
    OR NEW.membresia_tier      IS DISTINCT FROM OLD.membresia_tier
    OR NEW.membresia_activa_id IS DISTINCT FROM OLD.membresia_activa_id
    OR NEW.no_shows_count      IS DISTINCT FROM OLD.no_shows_count
    OR NEW.bloqueado_hasta     IS DISTINCT FROM OLD.bloqueado_hasta
    OR NEW.identidad_completa  IS DISTINCT FROM OLD.identidad_completa
    OR NEW.contrato_firmado    IS DISTINCT FROM OLD.contrato_firmado
    OR NEW.contrato_firmado_at IS DISTINCT FROM OLD.contrato_firmado_at
    OR NEW.avatar_url          IS DISTINCT FROM OLD.avatar_url
    OR NEW.sancionado_at       IS DISTINCT FROM OLD.sancionado_at
    OR NEW.sancion_motivo      IS DISTINCT FROM OLD.sancion_motivo
    OR NEW.email               IS DISTINCT FROM OLD.email
    OR NEW.auth_id             IS DISTINCT FROM OLD.auth_id
    OR NEW.notas_admin         IS DISTINCT FROM OLD.notas_admin
    OR NEW.invitado            IS DISTINCT FROM OLD.invitado THEN
      RAISE EXCEPTION
        'EKKO_NO_AUTORIZADO: No puedes modificar campos privilegiados de tu cuenta';
    END IF;
  END IF;

  -- Último admin: aplica a TODOS los actores. En un BEFORE trigger la fila aún es
  -- OLD, así que el conteo incluye a este mismo admin.
  IF OLD.rol = 'admin' AND OLD.status = 'activo'
     AND (NEW.rol IS DISTINCT FROM 'admin' OR NEW.status IS DISTINCT FROM 'activo')
     AND count_admins_activos(OLD.tenant_id) <= 1 THEN
    RAISE EXCEPTION
      'EKKO_ULTIMO_ADMIN: No puedes dejar el estudio sin ningún admin activo. Nombra otro admin primero.';
  END IF;

  -- R2-A (01L): un ADMIN por REST tampoco cambia campos de estado de negocio.
  -- Ser admin de la fila no autoriza a mutar invariantes: plan cacheado, puntero
  -- de membresía, penalizaciones, sanción, rol, identidad de acceso, contrato.
  -- Esas transiciones van por funciones/RPC del servidor (service_role/DEFINER,
  -- donde current_user no es 'authenticated'). Siguen permitidos al admin:
  -- nombre, telefono, avatar_url, notas_admin, identidad_completa (derivada del
  -- avatar) y status (revocar staff en Equipo; auditado y con guarda de sanción).
  IF current_user IN ('authenticated', 'anon') AND is_admin() THEN
    IF NEW.rol                 IS DISTINCT FROM OLD.rol
    OR NEW.tenant_id           IS DISTINCT FROM OLD.tenant_id
    OR NEW.membresia_tier      IS DISTINCT FROM OLD.membresia_tier
    OR NEW.membresia_activa_id IS DISTINCT FROM OLD.membresia_activa_id
    OR NEW.no_shows_count      IS DISTINCT FROM OLD.no_shows_count
    OR NEW.bloqueado_hasta     IS DISTINCT FROM OLD.bloqueado_hasta
    OR NEW.contrato_firmado    IS DISTINCT FROM OLD.contrato_firmado
    OR NEW.contrato_firmado_at IS DISTINCT FROM OLD.contrato_firmado_at
    OR NEW.sancionado_at       IS DISTINCT FROM OLD.sancionado_at
    OR NEW.sancion_motivo      IS DISTINCT FROM OLD.sancion_motivo
    OR NEW.email               IS DISTINCT FROM OLD.email
    OR NEW.auth_id             IS DISTINCT FROM OLD.auth_id
    OR NEW.invitado            IS DISTINCT FROM OLD.invitado THEN
      RAISE EXCEPTION
        'EKKO_CAMPO_PROTEGIDO: Ese campo solo cambia por una acción del sistema (plan, sanción, penalización, rol o acceso)';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reservar_recurso_atomic(
  p_recurso_id uuid,
  p_slot_inicio timestamptz,
  p_duracion_min integer,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_tenant_id uuid;
  v_usuario usuarios;
  v_recurso recursos;
  v_tenant tenants;
  v_slot_fin timestamptz;
  v_now timestamptz := now();
  v_min_anticipacion_h integer;
  v_permitir_continuas boolean;
  v_max_invitados integer;
  v_existe_continua boolean;
  v_existe_doble boolean;
  v_dia_semana text;
  v_slot_dentro_horario boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;
  v_max_sesiones_dia integer;
  v_sesiones_hoy integer;
  v_cancel_min_h numeric;
  v_tier tiers;
BEGIN
  v_user_id := get_my_user_id();
  v_tenant_id := get_my_tenant_id();

  IF v_user_id IS NULL OR v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Usuario no autenticado';
  END IF;

  -- FOR UPDATE: serializa las reservas concurrentes del mismo miembro (para que
  -- el tope diario y "horas continuas" cuenten bien ante dos submits a la vez).
  SELECT * INTO v_usuario FROM usuarios WHERE id = v_user_id FOR UPDATE;
  SELECT * INTO v_recurso FROM recursos WHERE id = p_recurso_id;
  SELECT * INTO v_tenant  FROM tenants  WHERE id = v_tenant_id;

  IF v_usuario.status != 'activo' THEN
    RAISE EXCEPTION 'EKKO_USUARIO_INACTIVO: Tu membresía no está activa (status: %)', v_usuario.status;
  END IF;

  IF v_usuario.bloqueado_hasta IS NOT NULL AND v_usuario.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'EKKO_USUARIO_BLOQUEADO: Tienes una restricción hasta el %',
      to_char(v_usuario.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  IF v_recurso IS NULL OR v_recurso.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_RECURSO_NO_EXISTE: Estudio no encontrado';
  END IF;

  IF NOT v_recurso.activo THEN
    RAISE EXCEPTION 'EKKO_RECURSO_INACTIVO: Este estudio no está disponible';
  END IF;

  -- R2-A (01K): el plan sale de la membresía VIVA, nunca de usuarios.membresia_tier
  -- (caché de display). Sin membresía viva: EKKO_SIN_MEMBRESIA (el mismo error
  -- que daba el trigger de débito, ahora antes de la puerta de plan).
  v_tier := _tier_vivo(v_user_id);
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: No hay un plan vigente. Se necesita un plan o paquete para reservar.';
  END IF;
  -- Gate de plan en UN solo lugar (_recurso_permite_tier): lista vacía = abierto.
  IF NOT _recurso_permite_tier(v_recurso.tiers_permitidos, v_tier.slug) THEN
    RAISE EXCEPTION 'EKKO_TIER_NO_PERMITIDO: Tu plan no tiene acceso a este estudio';
  END IF;

  -- R2-A (01K/01M): tope de invitados del plan VIVO; reglas.max_invitados es
  -- obligatorio (CHECK en tiers), sin fallbacks legados por slug.
  v_max_invitados := COALESCE((v_tier.reglas->>'max_invitados')::integer, 0);

  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_EXCEDEN: Tu plan permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_fin := p_slot_inicio + (p_duracion_min || ' minutes')::interval;

  v_min_anticipacion_h := COALESCE(
    (v_tenant.config->'reserva'->>'anticipacion_min_horas')::integer,
    (v_tenant.config->>'min_anticipacion_horas')::integer,
    24
  );

  IF p_slot_inicio < v_now + (v_min_anticipacion_h || ' hours')::interval THEN
    RAISE EXCEPTION 'EKKO_ANTICIPACION_INSUFICIENTE: Debes reservar con al menos % horas de anticipación', v_min_anticipacion_h;
  END IF;

  IF v_recurso.horarios IS NOT NULL AND jsonb_array_length(v_recurso.horarios) > 0 THEN
    v_dia_semana := CASE EXTRACT(DOW FROM (p_slot_inicio AT TIME ZONE 'America/Mazatlan'))::integer
      WHEN 0 THEN 'domingo'
      WHEN 1 THEN 'lunes'
      WHEN 2 THEN 'martes'
      WHEN 3 THEN 'miercoles'
      WHEN 4 THEN 'jueves'
      WHEN 5 THEN 'viernes'
      WHEN 6 THEN 'sabado'
    END;

    SELECT EXISTS(
      SELECT 1
      FROM jsonb_array_elements(v_recurso.horarios) AS bloque
      WHERE bloque->>'dia' = v_dia_semana
        AND (bloque->>'inicio')::time <= (p_slot_inicio AT TIME ZONE 'America/Mazatlan')::time
        AND (bloque->>'fin')::time   >= (v_slot_fin    AT TIME ZONE 'America/Mazatlan')::time
    ) INTO v_slot_dentro_horario;

    IF NOT v_slot_dentro_horario THEN
      RAISE EXCEPTION 'EKKO_FUERA_DE_HORARIO: Este horario no está disponible para este estudio';
    END IF;
  END IF;

  v_permitir_continuas := COALESCE(
    (v_tenant.config->'reserva'->>'permitir_continuas')::boolean,
    (v_tenant.config->>'permitir_continuas')::boolean,
    false
  );

  IF NOT v_permitir_continuas THEN
    SELECT EXISTS(
      SELECT 1 FROM reservas
      WHERE usuario_id = v_user_id
        AND status IN ('confirmada', 'completada')
        AND (slot_fin = p_slot_inicio OR slot_inicio = v_slot_fin)
    ) INTO v_existe_continua;

    IF v_existe_continua THEN
      RAISE EXCEPTION 'EKKO_CONTINUA: No puedes reservar horas continuas';
    END IF;
  END IF;

  v_max_sesiones_dia := COALESCE((v_tenant.config->'reserva'->>'max_sesiones_por_dia')::integer, 0);

  IF v_max_sesiones_dia > 0 THEN
    -- Cuentan también el no_show y la cancelación TARDÍA (dentro de la ventana
    -- de cancelación): antes liberaban el día y se re-reservaba gratis.
    v_cancel_min_h := COALESCE((v_tenant.config->'reserva'->>'cancelacion_min_horas_antes')::numeric, 0);
    SELECT count(*) INTO v_sesiones_hoy
    FROM reservas
    WHERE usuario_id = v_user_id
      AND (
        status IN ('confirmada', 'completada', 'no_show')
        OR (status = 'cancelada' AND v_cancel_min_h > 0 AND cancelada_at IS NOT NULL
            AND cancelada_at > slot_inicio - (v_cancel_min_h || ' hours')::interval)
      )
      AND (slot_inicio AT TIME ZONE 'America/Mazatlan')::date
          = (p_slot_inicio AT TIME ZONE 'America/Mazatlan')::date;

    IF v_sesiones_hoy >= v_max_sesiones_dia THEN
      RAISE EXCEPTION 'EKKO_LIMITE_DIARIO: Ya tienes el máximo de % sesión(es) por día', v_max_sesiones_dia;
    END IF;
  END IF;

  -- Chequeo de solape (rápido, para el mensaje amigable en el caso común).
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE recurso_id = p_recurso_id
      AND status IN ('confirmada', 'completada')
      AND tstzrange(slot_inicio, slot_fin, '[)') && tstzrange(p_slot_inicio, v_slot_fin, '[)')
  ) INTO v_existe_doble;

  IF v_existe_doble THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya está reservado';
  END IF;

  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'EKK-' || lpad((v_folio_count + 1)::text, 6, '0');

  -- Red dura: si dos carreras pasaron el SELECT, el EXCLUDE gist rechaza el 2º
  -- INSERT → se traduce a EKKO_SLOT_OCUPADO en vez del error crudo del constraint.
  BEGIN
    INSERT INTO reservas (
      tenant_id, recurso_id, usuario_id,
      slot_inicio, slot_fin, duracion_min,
      invitados_count, status, folio, notas
    ) VALUES (
      v_tenant_id, p_recurso_id, v_user_id,
      p_slot_inicio, v_slot_fin, p_duracion_min,
      p_invitados, 'confirmada', v_folio_nuevo, p_notas
    ) RETURNING id INTO v_reserva_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya está reservado';
  END;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo
  );
END;
$$;

CREATE OR REPLACE FUNCTION reservar_para_miembro_atomic(
  p_usuario_id uuid,
  p_recurso_id uuid,
  p_slot_inicio timestamptz,
  p_duracion_min integer,
  p_invitados integer DEFAULT 0,
  p_notas text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol text;
  v_tenant_id uuid;
  v_miembro usuarios;
  v_recurso recursos;
  v_slot_fin timestamptz;
  v_now timestamptz := now();
  v_max_invitados integer;
  v_existe_continua boolean;
  v_existe_doble boolean;
  v_folio_count integer;
  v_folio_nuevo text;
  v_reserva_id uuid;
  v_tenant tenants;
  v_permitir_continuas boolean;
  v_dia_semana text;
  v_slot_dentro_horario boolean;
  v_tier tiers;
BEGIN
  v_rol := get_my_rol();
  v_tenant_id := get_my_tenant_id();

  -- Gate de rol — solo recepción o admin (patrón de check_in_*_atomic).
  IF v_rol IS NULL OR v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden reservar para un miembro';
  END IF;

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Sesión inválida';
  END IF;

  -- Miembro objetivo: debe existir y ser del MISMO tenant.
  -- FOR UPDATE: serializa reservas concurrentes del mismo miembro (igual que la
  -- RPC del socio) para que "continuas" y el solape cuenten bien.
  SELECT * INTO v_miembro
  FROM usuarios
  WHERE id = p_usuario_id AND tenant_id = v_tenant_id
  FOR UPDATE;
  SELECT * INTO v_tenant FROM tenants WHERE id = v_tenant_id;

  IF v_miembro.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro no encontrado o de otro estudio';
  END IF;

  -- D2: solo miembros activos.
  IF v_miembro.status != 'activo' THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_NO_ACTIVO: El miembro no está activo (%). Avisá a administración', v_miembro.status;
  END IF;

  -- Penalización por no-show: se respeta (no waived por D1/D2).
  IF v_miembro.bloqueado_hasta IS NOT NULL AND v_miembro.bloqueado_hasta > v_now THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_BLOQUEADO: El miembro tiene una restricción hasta el %',
      to_char(v_miembro.bloqueado_hasta, 'DD/MM/YYYY HH24:MI');
  END IF;

  -- Recurso: existe, del tenant, activo.
  SELECT * INTO v_recurso FROM recursos WHERE id = p_recurso_id;

  IF v_recurso.id IS NULL OR v_recurso.tenant_id != v_tenant_id THEN
    RAISE EXCEPTION 'EKKO_RECURSO_NO_EXISTE: Estudio no encontrado';
  END IF;

  IF NOT v_recurso.activo THEN
    RAISE EXCEPTION 'EKKO_RECURSO_INACTIVO: Este estudio no está disponible';
  END IF;

  -- Tier del miembro permite el recurso.
  -- Gate de plan en UN solo lugar (_recurso_permite_tier): lista vacía = abierto.
  -- R2-A (01K): plan de la membresía VIVA del miembro, no el slug cacheado.
  v_tier := _tier_vivo(v_miembro.id);
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_SIN_MEMBRESIA: No hay un plan vigente. Se necesita un plan o paquete para reservar.';
  END IF;
  IF NOT _recurso_permite_tier(v_recurso.tiers_permitidos, v_tier.slug) THEN
    RAISE EXCEPTION 'EKKO_TIER_NO_PERMITIDO: El plan del miembro no tiene acceso a este estudio';
  END IF;

  -- Invitados dentro del límite del plan: tiers.reglas.max_invitados (el CASE
  -- legacy pro/basica solo como fallback; con los planes actuales daba 0).
  v_max_invitados := COALESCE((v_tier.reglas->>'max_invitados')::integer, 0);
  IF p_invitados < 0 THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_INVALIDOS: Número de invitados inválido';
  END IF;
  IF p_invitados > v_max_invitados THEN
    RAISE EXCEPTION 'EKKO_INVITADOS_EXCEDEN: El plan del miembro permite máximo % invitados', v_max_invitados;
  END IF;

  v_slot_fin := p_slot_inicio + (p_duracion_min || ' minutes')::interval;

  -- D1: NO se valida min_anticipacion_horas — recepción reserva walk-ins.

  -- Horario del estudio (mismo chequeo que la RPC del socio, en la zona del
  -- estudio). Antes recepción podía reservar fuera del horario publicado.
  IF v_recurso.horarios IS NOT NULL AND jsonb_array_length(v_recurso.horarios) > 0 THEN
    v_dia_semana := CASE EXTRACT(DOW FROM (p_slot_inicio AT TIME ZONE 'America/Mazatlan'))::integer
      WHEN 0 THEN 'domingo'
      WHEN 1 THEN 'lunes'
      WHEN 2 THEN 'martes'
      WHEN 3 THEN 'miercoles'
      WHEN 4 THEN 'jueves'
      WHEN 5 THEN 'viernes'
      WHEN 6 THEN 'sabado'
    END;
    SELECT EXISTS(
      SELECT 1
      FROM jsonb_array_elements(v_recurso.horarios) AS bloque
      WHERE bloque->>'dia' = v_dia_semana
        AND (bloque->>'inicio')::time <= (p_slot_inicio AT TIME ZONE 'America/Mazatlan')::time
        AND (bloque->>'fin')::time   >= (v_slot_fin    AT TIME ZONE 'America/Mazatlan')::time
    ) INTO v_slot_dentro_horario;
    IF NOT v_slot_dentro_horario THEN
      RAISE EXCEPTION 'EKKO_FUERA_DE_HORARIO: Este horario no está dentro del horario del estudio';
    END IF;
  END IF;

  -- No-continuas: respeta config.reserva.permitir_continuas del tenant (antes
  -- recepción SIEMPRE prohibía, aunque el estudio lo permitiera).
  v_permitir_continuas := COALESCE(
    (v_tenant.config->'reserva'->>'permitir_continuas')::boolean,
    (v_tenant.config->>'permitir_continuas')::boolean,
    false
  );
  IF NOT v_permitir_continuas THEN
    SELECT EXISTS(
      SELECT 1 FROM reservas
      WHERE usuario_id = p_usuario_id
        AND status IN ('confirmada', 'completada')
        AND (slot_fin = p_slot_inicio OR slot_inicio = v_slot_fin)
    ) INTO v_existe_continua;

    IF v_existe_continua THEN
      RAISE EXCEPTION 'EKKO_CONTINUA: El miembro ya tiene una reserva en una hora contigua';
    END IF;
  END IF;

  -- Slot del recurso libre (no solape).
  SELECT EXISTS(
    SELECT 1 FROM reservas
    WHERE recurso_id = p_recurso_id
      AND status IN ('confirmada', 'completada')
      AND tstzrange(slot_inicio, slot_fin, '[)') && tstzrange(p_slot_inicio, v_slot_fin, '[)')
  ) INTO v_existe_doble;

  IF v_existe_doble THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya está reservado';
  END IF;

  -- Folio.
  SELECT count(*) INTO v_folio_count FROM reservas WHERE tenant_id = v_tenant_id;
  v_folio_nuevo := 'EKK-' || lpad((v_folio_count + 1)::text, 6, '0');

  -- Red dura: si dos carreras pasaron el SELECT, el EXCLUDE gist rechaza el 2º
  -- INSERT → se traduce a EKKO_SLOT_OCUPADO (antes llegaba el error crudo del
  -- constraint `reservas_no_overlap` a la pantalla de recepción).
  BEGIN
    INSERT INTO reservas (
      tenant_id, recurso_id, usuario_id,
      slot_inicio, slot_fin, duracion_min,
      invitados_count, status, folio, notas
    ) VALUES (
      v_tenant_id, p_recurso_id, p_usuario_id,
      p_slot_inicio, v_slot_fin, p_duracion_min,
      p_invitados, 'confirmada', v_folio_nuevo, p_notas
    ) RETURNING id INTO v_reserva_id;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'EKKO_SLOT_OCUPADO: Este horario ya está reservado';
  END;

  RETURN jsonb_build_object(
    'success', true,
    'reserva_id', v_reserva_id,
    'folio', v_folio_nuevo
  );
END;
$$;

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
  v_pen jsonb;
  v_umbral integer;
  v_bloqueo_dias integer;
  v_antes_count integer;
  v_antes_bloqueo timestamptz;
  v_despues_count integer;
  v_despues_bloqueo timestamptz;
  v_bloquea boolean;
  v_titulo text;
  v_mensaje text;
  v_restantes integer;
  r record;
BEGIN
  FOR r IN
    SELECT res.id, res.usuario_id, res.tenant_id, res.folio, t.config AS tenant_config
    FROM reservas res
    JOIN tenants t ON t.id = res.tenant_id
    WHERE res.status = 'confirmada'
      AND res.check_in_at IS NULL
      -- +60 min: alineado con la ventana del check-in manual.
      AND res.slot_fin + interval '60 minutes' < v_now
  LOOP
    -- Config del tenant, tolerante a basura (solo enteros no negativos).
    v_pen := COALESCE(r.tenant_config->'penalizaciones', '{}'::jsonb);
    v_bloqueo_dias := COALESCE(
      CASE WHEN (v_pen->>'no_show_bloqueo_dias') ~ '^\d+$' THEN (v_pen->>'no_show_bloqueo_dias')::integer END,
      7
    );
    v_umbral := GREATEST(1, COALESCE(
      CASE WHEN (v_pen->>'no_show_umbral') ~ '^\d+$' THEN (v_pen->>'no_show_umbral')::integer END,
      3
    ));

    -- R2-A (01I): transición condicionada; si alguien la cambió (check-in tardío,
    -- cancelación) entre el SELECT y aquí, no se pisa ni se penaliza.
    UPDATE reservas SET status = 'no_show'
    WHERE id = r.id AND status = 'confirmada' AND check_in_at IS NULL;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_reservas_afectadas := v_reservas_afectadas + 1;

    SELECT no_shows_count, bloqueado_hasta
      INTO v_antes_count, v_antes_bloqueo
      FROM usuarios WHERE id = r.usuario_id;

    v_bloquea := v_bloqueo_dias > 0 AND (COALESCE(v_antes_count, 0) + 1) >= v_umbral;

    UPDATE usuarios
    SET no_shows_count = no_shows_count + 1,
        bloqueado_hasta = CASE
          WHEN v_bloquea
          THEN GREATEST(COALESCE(bloqueado_hasta, v_now), v_now) + (v_bloqueo_dias || ' days')::interval
          ELSE bloqueado_hasta
        END
    WHERE id = r.usuario_id
    RETURNING no_shows_count, bloqueado_hasta INTO v_despues_count, v_despues_bloqueo;

    IF v_bloquea THEN
      v_usuarios_bloqueados := v_usuarios_bloqueados + 1;
    END IF;

    -- Aviso al miembro (mismo texto que _lib/noShow.ts).
    IF v_bloquea THEN
      v_titulo := 'Cuenta bloqueada por inasistencia';
      v_mensaje := format(
        'No llegaste a tu sesión reservada (%s). Llevas %s de %s faltas permitidas. Tu cuenta queda bloqueada para reservar hasta el %s.',
        COALESCE(r.folio, 'sin folio'), v_despues_count, v_umbral,
        to_char(v_despues_bloqueo AT TIME ZONE 'America/Mazatlan', 'DD/MM')
      );
    ELSE
      v_restantes := GREATEST(0, v_umbral - v_despues_count);
      v_titulo := 'Registramos una inasistencia';
      v_mensaje := format(
        'No llegaste a tu sesión reservada (%s). Llevas %s de %s faltas permitidas.%s',
        COALESCE(r.folio, 'sin folio'), v_despues_count, v_umbral,
        CASE
          WHEN v_bloqueo_dias > 0 AND v_restantes > 0 THEN
            format(' Si faltas %s, tu cuenta se bloquea %s días.',
              CASE WHEN v_restantes = 1 THEN 'una vez más' ELSE v_restantes || ' veces más' END,
              v_bloqueo_dias)
          ELSE ''
        END
      );
    END IF;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      r.tenant_id, r.usuario_id, 'no_show', v_titulo, v_mensaje,
      jsonb_build_object('reserva_id', r.id, 'folio', r.folio, 'bloqueado_hasta', v_despues_bloqueo)
    );

    INSERT INTO audit_log (
      tenant_id, actor_usuario_id, actor_rol, accion,
      target_tipo, target_id, antes, despues, metadata
    ) VALUES (
      r.tenant_id, NULL, 'service_role', 'no_show_cron',
      'usuario', r.usuario_id,
      jsonb_build_object('reserva_status', 'confirmada', 'no_shows_count', v_antes_count, 'bloqueado_hasta', v_antes_bloqueo),
      jsonb_build_object('reserva_status', 'no_show', 'no_shows_count', v_despues_count, 'bloqueado_hasta', v_despues_bloqueo),
      jsonb_build_object('reserva_id', r.id, 'folio', r.folio, 'umbral', v_umbral, 'bloqueo_dias', v_bloqueo_dias)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'reservas_afectadas', v_reservas_afectadas,
    'usuarios_bloqueados', v_usuarios_bloqueados,
    'timestamp', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION cancelar_reserva_atomic(
  p_reserva_id uuid,
  p_motivo text DEFAULT NULL
)
RETURNS reservas
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_reserva reservas;
  v_por_tercero boolean;
  v_mensaje text;
  v_cancel_min_h numeric;
BEGIN
  v_user_id := get_my_user_id();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH';
  END IF;

  -- R2-A (01I): FOR UPDATE serializa cancelaciones/correcciones concurrentes.
  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;

  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE';
  END IF;

  IF v_reserva.usuario_id != v_user_id AND NOT is_recepcionista() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: No puedes cancelar esta reserva';
  END IF;

  IF v_reserva.usuario_id != v_user_id
     AND v_reserva.tenant_id IS DISTINCT FROM get_my_tenant_id() THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: La reserva pertenece a otro estudio';
  END IF;

  IF v_reserva.status != 'confirmada' THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_CANCELABLE: La reserva no está confirmada';
  END IF;

  IF v_reserva.slot_inicio < now() THEN
    RAISE EXCEPTION 'EKKO_RESERVA_PASADA: No puedes cancelar una reserva que ya pasó';
  END IF;

  v_por_tercero := (v_reserva.usuario_id != v_user_id);

  -- Ventana de cancelación: SOLO aplica al miembro que cancela lo suyo.
  -- Recepción/admin (v_por_tercero) cancelan cuando sea.
  IF NOT v_por_tercero THEN
    SELECT COALESCE((config->'reserva'->>'cancelacion_min_horas_antes')::numeric, 0)
      INTO v_cancel_min_h
      FROM tenants WHERE id = v_reserva.tenant_id;

    IF v_cancel_min_h > 0
       AND v_reserva.slot_inicio < now() + (v_cancel_min_h || ' hours')::interval THEN
      RAISE EXCEPTION 'EKKO_CANCELACION_TARDIA: Ya no puedes cancelar esta reserva por tu cuenta (faltan menos de % horas). Contacta a recepción.', v_cancel_min_h;
    END IF;
  END IF;

  IF v_por_tercero THEN
    UPDATE reservas
    SET status = 'cancelada_admin',
        cancelada_at = now(),
        cancelada_motivo = p_motivo,
        cancelada_por = v_user_id,
        cancelacion_notificada_at = now()
    WHERE id = p_reserva_id
    RETURNING * INTO v_reserva;

    -- Hora de pared del ESTUDIO. Antes era to_char(slot_inicio, …) a secas: salía
    -- en UTC ("del 21/09 23:00" para una sesión de las 16:00) — y este texto ahora
    -- también se manda por correo.
    v_mensaje := 'Tu reserva del '
      || _fecha_hora_estudio(v_reserva.slot_inicio)
      || ' fue cancelada por el estudio.'
      || CASE WHEN p_motivo IS NOT NULL AND length(trim(p_motivo)) > 0
              THEN ' Motivo: ' || p_motivo ELSE '' END;

    INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
    VALUES (
      v_reserva.tenant_id,
      v_reserva.usuario_id,
      'reserva_cancelada',
      'Tu reserva fue cancelada',
      v_mensaje,
      jsonb_build_object('reserva_id', p_reserva_id, 'url', '/app/reservas')
    );
  ELSE
    UPDATE reservas
    SET status = 'cancelada',
        cancelada_at = now(),
        cancelada_motivo = p_motivo
    WHERE id = p_reserva_id
    RETURNING * INTO v_reserva;
  END IF;

  RETURN v_reserva;
END;
$$;

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
    -- R2-A (01J): pagos aplicados ATRIBUIDOS hoy a la reserva (origen o destino
    -- de un traslado por reprogramación). Sin traslados = SUM(reserva_id) de 01H.
    v_suma := _extras_atribuidos(v_reserva.id);
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

-- ── 4. Corrección de asistencia en el servidor (01I) ─────────────────────────
-- La llaman reception-marcar-asistio y reception-corregir-checkin (service_role)
-- con el actor ya autenticado. Toda la corrección ocurre en UNA transacción con
-- la reserva y el miembro bloqueados. NUNCA toca créditos: un no_show ya
-- consumió su crédito y "sí asistió" no lo devuelve ni lo vuelve a cobrar.
CREATE OR REPLACE FUNCTION staff_corregir_asistencia(
  p_actor_id   uuid,
  p_reserva_id uuid,
  p_accion     text,
  p_motivo     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor    usuarios;
  v_reserva  reservas;
  v_miembro  usuarios;
  v_motivo   text := trim(COALESCE(p_motivo, ''));
  v_pen      jsonb;
  v_umbral   integer;
  v_count    integer;
  v_bloqueo  timestamptz;
  v_antes    jsonb;
  v_despues  jsonb;
BEGIN
  IF p_accion NOT IN ('asistio', 'deshacer_checkin') THEN
    RAISE EXCEPTION 'EKKO_ACCION_INVALIDA: Acción de asistencia desconocida';
  END IF;
  IF length(v_motivo) < 3 THEN
    RAISE EXCEPTION 'EKKO_MOTIVO_REQUERIDO: Motivo obligatorio para esta acción';
  END IF;

  SELECT * INTO v_actor FROM usuarios WHERE id = p_actor_id;
  IF v_actor.id IS NULL OR v_actor.status IS DISTINCT FROM 'activo'
     OR v_actor.rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden corregir asistencia';
  END IF;

  SELECT * INTO v_reserva FROM reservas WHERE id = p_reserva_id FOR UPDATE;
  IF v_reserva.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: Reserva no encontrada';
  END IF;
  IF v_reserva.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'EKKO_OTRO_ESTUDIO: La reserva pertenece a otro estudio';
  END IF;

  IF p_accion = 'asistio' THEN
    -- Única transición permitida: no_show → completada. Una cancelada ya
    -- devolvió su crédito y liberó el horario: revivirla sería una sesión gratis.
    IF v_reserva.status = 'completada' THEN
      RAISE EXCEPTION 'EKKO_YA_COMPLETADA: Esta reserva ya tiene check-in';
    END IF;
    IF v_reserva.status IN ('cancelada', 'cancelada_admin') THEN
      RAISE EXCEPTION 'EKKO_TRANSICION_INVALIDA: Una reserva cancelada no se revive; crea una reserva nueva';
    END IF;
    IF v_reserva.status <> 'no_show' THEN
      RAISE EXCEPTION 'EKKO_TRANSICION_INVALIDA: Solo se corrige la asistencia de una reserva marcada como no asistió (estado: %)', v_reserva.status;
    END IF;
    IF v_reserva.slot_inicio > now() THEN
      RAISE EXCEPTION 'EKKO_SESION_NO_INICIA: Esa sesión todavía no empieza';
    END IF;

    -- check_in_method='manual': aplican la guarda de identidad, el bloqueo de
    -- cuenta revocada (R1) y la auditoría de ingreso con restricción.
    UPDATE reservas
    SET status = 'completada', check_in_at = now(), check_in_by = v_actor.id, check_in_method = 'manual'
    WHERE id = v_reserva.id AND status = 'no_show';

    -- Revertir la falta con el miembro bloqueado (antes: lectura-escritura sin
    -- lock desde Netlify, separada del UPDATE de la reserva).
    SELECT * INTO v_miembro FROM usuarios WHERE id = v_reserva.usuario_id FOR UPDATE;
    SELECT COALESCE(config->'penalizaciones', '{}'::jsonb) INTO v_pen FROM tenants WHERE id = v_reserva.tenant_id;
    v_umbral := GREATEST(1, COALESCE(
      CASE WHEN (v_pen->>'no_show_umbral') ~ '^\d+$' THEN (v_pen->>'no_show_umbral')::integer END, 3));
    v_count := GREATEST(0, COALESCE(v_miembro.no_shows_count, 0) - 1);
    v_bloqueo := CASE
      WHEN v_miembro.bloqueado_hasta IS NOT NULL AND v_miembro.bloqueado_hasta > now() AND v_count < v_umbral
      THEN NULL ELSE v_miembro.bloqueado_hasta END;
    UPDATE usuarios SET no_shows_count = v_count, bloqueado_hasta = v_bloqueo WHERE id = v_miembro.id;

    v_antes := jsonb_build_object('reserva_status', 'no_show',
      'no_shows_count', v_miembro.no_shows_count, 'bloqueado_hasta', v_miembro.bloqueado_hasta);
    v_despues := jsonb_build_object('reserva_status', 'completada',
      'no_shows_count', v_count, 'bloqueado_hasta', v_bloqueo);
    INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
    VALUES (v_reserva.tenant_id, v_actor.id, v_actor.rol, 'asistencia_correction', 'usuario', v_reserva.usuario_id,
            v_antes, v_despues, v_motivo,
            jsonb_build_object('reserva_id', v_reserva.id, 'folio', v_reserva.folio));

    RETURN jsonb_build_object('success', true, 'status', 'completada',
      'penalizacion', jsonb_build_object('no_shows_count', v_count, 'bloqueado_hasta', v_bloqueo));
  END IF;

  -- deshacer_checkin: solo completada → confirmada, el MISMO día del check-in.
  IF v_reserva.status <> 'completada' OR v_reserva.check_in_at IS NULL THEN
    RAISE EXCEPTION 'EKKO_TRANSICION_INVALIDA: La reserva no tiene check-in que corregir (estado: %)', v_reserva.status;
  END IF;
  IF (v_reserva.check_in_at AT TIME ZONE 'America/Mazatlan')::date <> (now() AT TIME ZONE 'America/Mazatlan')::date THEN
    RAISE EXCEPTION 'EKKO_FUERA_DE_PLAZO: Solo se puede corregir un check-in del mismo día';
  END IF;

  UPDATE reservas
  SET status = 'confirmada', check_in_at = NULL, check_in_by = NULL, check_in_method = NULL
  WHERE id = v_reserva.id AND status = 'completada';

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (v_reserva.tenant_id, v_actor.id, v_actor.rol, 'checkin_correction', 'usuario', v_reserva.usuario_id,
          jsonb_build_object('status', v_reserva.status, 'check_in_at', v_reserva.check_in_at, 'check_in_method', v_reserva.check_in_method),
          jsonb_build_object('status', 'confirmada', 'check_in_at', NULL, 'check_in_method', NULL),
          v_motivo, jsonb_build_object('reserva_id', v_reserva.id, 'folio', v_reserva.folio));

  RETURN jsonb_build_object('success', true, 'status', 'confirmada');
END;
$$;
REVOKE ALL ON FUNCTION staff_corregir_asistencia(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_corregir_asistencia(uuid, uuid, text, text) TO service_role;

-- ── 5. Reprogramación atómica (01J) ──────────────────────────────────────────
-- Cancelar la vieja + crear la nueva (misma RPC y reglas que recepción usa para
-- reservar) + trasladar invitados + un solo aviso + auditoría. Cualquier error
-- revierte TODO: la original queda intacta y no se mueve ningún crédito.
-- Créditos: la cancelación devuelve (trigger) y la nueva debita (trigger) →
-- neto cero, cada movimiento en el ledger con su reserva.
CREATE OR REPLACE FUNCTION reprogramar_reserva(
  p_reserva_id   uuid,
  p_recurso_id   uuid,
  p_slot_inicio  timestamptz,
  p_duracion_min integer DEFAULT NULL,
  p_invitados    integer DEFAULT NULL,
  p_notas        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rol       text := get_my_rol();
  v_tenant    uuid := get_my_tenant_id();
  v_actor     uuid := get_my_user_id();
  v_vieja     reservas;
  v_nueva     reservas;
  v_res       jsonb;
  v_extras    integer;
  v_tope      integer;
  v_fichas    integer;
  v_pago      record;
  v_set_viejo text;
  v_set_nuevo text;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Sesión inválida';
  END IF;
  IF v_rol IS NULL OR v_rol NOT IN ('admin', 'recepcionista') THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo recepción o admin pueden reprogramar';
  END IF;

  SELECT * INTO v_vieja FROM reservas WHERE id = p_reserva_id FOR UPDATE;
  IF v_vieja.id IS NULL OR v_vieja.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'EKKO_RESERVA_NO_EXISTE: Reserva no encontrada';
  END IF;
  IF v_vieja.status <> 'confirmada' THEN
    RAISE EXCEPTION 'EKKO_REPROGRAMAR_NO_VIGENTE: Solo se reprograma una reserva confirmada (estado: %)', v_vieja.status;
  END IF;
  IF v_vieja.slot_inicio < now() THEN
    RAISE EXCEPTION 'EKKO_REPROGRAMAR_PASADA: Esa sesión ya empezó; no se puede reprogramar';
  END IF;
  IF v_vieja.recurso_id = p_recurso_id AND v_vieja.slot_inicio = p_slot_inicio
     AND v_vieja.duracion_min = COALESCE(p_duracion_min, v_vieja.duracion_min) THEN
    RAISE EXCEPTION 'EKKO_MISMO_HORARIO: Ese es el horario actual de la reserva';
  END IF;

  -- 1) Cancelar la vieja (libera el horario; el trigger devuelve su crédito y
  --    trg_auditar_cancelacion_staff deja quién fue).
  UPDATE reservas
  SET status = 'cancelada_admin', cancelada_at = now(), cancelada_motivo = 'Reprogramada',
      cancelada_por = v_actor, cancelacion_notificada_at = now()
  WHERE id = v_vieja.id AND status = 'confirmada';

  -- 2) Crear la nueva con las MISMAS reglas que una reserva de recepción
  --    (plan vivo, horario, solape, continuas, bloqueo, débito). Si falla,
  --    la excepción revierte también el paso 1.
  v_res := reservar_para_miembro_atomic(
    v_vieja.usuario_id, p_recurso_id, p_slot_inicio,
    COALESCE(p_duracion_min, v_vieja.duracion_min),
    COALESCE(p_invitados, v_vieja.invitados_count),
    COALESCE(p_notas, v_vieja.notas)
  );
  UPDATE reservas
  SET reprogramada_desde = v_vieja.id, observaciones = v_vieja.observaciones
  WHERE id = (v_res->>'reserva_id')::uuid
  RETURNING * INTO v_nueva;

  -- 3) Invitados extra PAGADOS viajan con la reserva (traslado trazable; la
  --    evidencia del pago no se reescribe).
  v_extras := COALESCE(v_vieja.invitados_extra_pagados, 0);
  IF v_extras > 0 THEN
    IF _extras_atribuidos(v_vieja.id) <> v_extras THEN
      RAISE EXCEPTION 'EKKO_EXTRAS_INCONSISTENTES: Los invitados extra pagados de la reserva no cuadran con sus pagos; revísalo antes de reprogramar';
    END IF;
    SELECT COALESCE(max_invitados_extra, 0) INTO v_tope FROM recursos WHERE id = p_recurso_id;
    IF v_extras > v_tope THEN
      RAISE EXCEPTION 'EKKO_EXTRAS_EXCEDEN_TOPE: La reserva tiene % invitado(s) extra pagado(s) y ese estudio admite %', v_extras, v_tope;
    END IF;
    FOR v_pago IN
      SELECT p.id, p.cantidad FROM invitados_extra_pagos p
      WHERE p.estado = 'aplicado'
        AND COALESCE((SELECT t.reserva_destino_id FROM invitados_extra_traslados t
                      WHERE t.pago_id = p.id ORDER BY t.seq DESC LIMIT 1), p.reserva_id) = v_vieja.id
      ORDER BY p.created_at, p.id
    LOOP
      INSERT INTO invitados_extra_traslados (tenant_id, pago_id, reserva_origen_id, reserva_destino_id, cantidad, actor_usuario_id)
      VALUES (v_tenant, v_pago.id, v_vieja.id, v_nueva.id, v_pago.cantidad, v_actor);
    END LOOP;
    UPDATE reservas SET invitados_extra_pagados = 0 WHERE id = v_vieja.id;
    UPDATE reservas SET invitados_extra_pagados = v_extras WHERE id = v_nueva.id
    RETURNING * INTO v_nueva;
  END IF;

  -- 4) Fichas de invitados ya registradas: se mueven si la nueva las cubre.
  SELECT count(*) INTO v_fichas FROM reserva_invitados WHERE reserva_id = v_vieja.id;
  IF v_fichas > 0 THEN
    IF v_fichas > v_nueva.invitados_count + COALESCE(v_nueva.invitados_extra_pagados, 0) THEN
      RAISE EXCEPTION 'EKKO_FICHAS_EXCEDEN: La reserva tiene % invitado(s) registrados y la nueva cubre %',
        v_fichas, v_nueva.invitados_count + COALESCE(v_nueva.invitados_extra_pagados, 0);
    END IF;
    UPDATE reserva_invitados SET reserva_id = v_nueva.id WHERE reserva_id = v_vieja.id;
    UPDATE reserva_invitados ri SET es_extra = o.n > v_nueva.invitados_count
    FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n
          FROM reserva_invitados WHERE reserva_id = v_nueva.id) o
    WHERE ri.id = o.id;
  END IF;

  -- 5) UN aviso de cambio de horario (no "te agendamos…" + "te cancelamos…").
  SELECT nombre INTO v_set_viejo FROM recursos WHERE id = v_vieja.recurso_id;
  SELECT nombre INTO v_set_nuevo FROM recursos WHERE id = v_nueva.recurso_id;
  DELETE FROM notificaciones
  WHERE usuario_id = v_vieja.usuario_id AND tipo = 'reserva_confirmada'
    AND metadata->>'reserva_id' = v_nueva.id::text;
  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (
    v_tenant, v_vieja.usuario_id, 'reserva_reprogramada',
    'Tu sesión cambió de horario',
    'Era ' || COALESCE(v_set_viejo, 'el estudio') || ' el ' || _fecha_hora_estudio(v_vieja.slot_inicio)
      || '. Ahora es ' || COALESCE(v_set_nuevo, 'el estudio') || ' el ' || _fecha_hora_estudio(v_nueva.slot_inicio)
      || ' (' || v_nueva.duracion_min || ' min).'
      || CASE WHEN v_nueva.folio IS NOT NULL THEN ' Folio ' || v_nueva.folio || '.' ELSE '' END
      || ' Si agregaste la anterior a tu calendario, actualízala.',
    jsonb_build_object('reserva_id', v_nueva.id, 'reserva_anterior_id', v_vieja.id, 'url', '/app/qr/' || v_nueva.id)
  );

  -- 6) Auditoría de la operación compuesta (en el historial del miembro).
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo, metadata)
  VALUES (
    v_tenant, v_actor, v_rol, 'reserva_reprogramada', 'usuario', v_vieja.usuario_id,
    jsonb_build_object('reserva_id', v_vieja.id, 'folio', v_vieja.folio, 'recurso_id', v_vieja.recurso_id,
                       'slot_inicio', v_vieja.slot_inicio, 'duracion_min', v_vieja.duracion_min,
                       'invitados_count', v_vieja.invitados_count, 'invitados_extra_pagados', v_extras),
    jsonb_build_object('reserva_id', v_nueva.id, 'folio', v_nueva.folio, 'recurso_id', v_nueva.recurso_id,
                       'slot_inicio', v_nueva.slot_inicio, 'duracion_min', v_nueva.duracion_min,
                       'invitados_count', v_nueva.invitados_count, 'invitados_extra_pagados', v_nueva.invitados_extra_pagados),
    'Reprogramada',
    jsonb_build_object('fichas_movidas', v_fichas, 'extras_trasladados', v_extras)
  );

  RETURN jsonb_build_object('success', true, 'reserva_id', v_nueva.id, 'folio', v_nueva.folio,
                            'reserva_anterior_id', v_vieja.id);
END;
$$;
REVOKE ALL ON FUNCTION reprogramar_reserva(uuid, uuid, timestamptz, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reprogramar_reserva(uuid, uuid, timestamptz, integer, integer, text) TO authenticated;

-- ── 6. Admin: leer sí, escribir estado de negocio por REST no (01L) ──────────
-- Las escrituras de reservas, membresías y datos privados van por RPC/servidor.
-- La lectura del admin sigue cubierta por reservas_read_admin,
-- membresias_read_admin y udp_admin_read (abajo).
DROP POLICY IF EXISTS reservas_admin_all ON reservas;
DROP POLICY IF EXISTS membresias_admin_all ON membresias;
DROP POLICY IF EXISTS udp_admin_all ON usuarios_datos_privados;
DROP POLICY IF EXISTS udp_admin_read ON usuarios_datos_privados;
CREATE POLICY udp_admin_read ON usuarios_datos_privados
  FOR SELECT TO authenticated USING (tenant_id = get_my_tenant_id() AND is_admin());
-- Alta de usuarios: la hacen funciones con service_role (invitar staff, alta de
-- miembro); un INSERT directo del admin podía crear filas con rol/plan arbitrario.
DROP POLICY IF EXISTS usuarios_insert_admin ON usuarios;
