-- ============================================================================
-- PKG-06A · Operaciones compuestas de cuenta con frontera del servidor
-- (EKKO-142 · D-FIN-1 = A)
-- ============================================================================
-- Las altas, cambios de rol, bajas, reseteos y ediciones de cuenta corrían como
-- "Auth Admin API + escrituras sueltas con service_role + auditoría best-effort":
-- el actor quedaba NULL ('sistema'), un alta podía adueñarse de un perfil
-- existente solo por el correo (y su rollback borrarlo en cascada), y borrar a
-- un usuario arrastraba membresías y el ledger de créditos sin dejar rastro.
--
-- Aquí la parte LOCAL de cada operación compuesta es UNA transacción con actor
-- explícito y auditoría dentro. Lo que toca al proveedor de Auth (crear, borrar,
-- cambiar correo o contraseña) sigue fuera —no hay atomicidad distribuida— y la
-- función de Netlify lo ordena para que ningún fallo destruya estado previo.
--
--  1. `cuenta_historial_durable(id)`: UNA definición de "esta cuenta tiene
--     historial que no se destruye" (membresías, ledger, pagos, reservas, ventas,
--     material, reversales, operaciones y discrepancias de Stripe, notas, cliente
--     de Stripe). La usan la vinculación por correo y la guardia de borrado.
--  2. `handle_new_auth_user`: vincular por correo solo a un perfil SIN acceso y
--     (a) sin historial —cascarón—, o (b) con autorización explícita de un staff
--     sobre ESE perfil (`acceso_autorizado_at/por`). Con historial y sin
--     autorización → EKKO_PERFIL_CON_HISTORIAL y el alta en Auth no ocurre.
--  3. RPC de servicio (solo service_role, actor por parámetro validado):
--     cuenta_alta_preparar · cuenta_alta_finalizar · cuenta_cambiar_rol ·
--     cuenta_eliminar · cuenta_password_reseteada · staff_actualizar_cuenta ·
--     auth_usuario_sin_perfil.
--  4. El actor validado se publica como `request.jwt.claim.sub` SOLO dentro de la
--     transacción: los triggers de auditoría de R1 (`_audit_actor`) registran a
--     la persona real en vez de 'sistema'. R1 no se recrea.
--  5. D-FIN-1 = A: con historial durable NO hay borrado físico; se usa la
--     revocación. El borrado permitido deja `cuenta_eliminada` ANTES del DELETE
--     (target_id sin FK: sobrevive) y borra la fila local en la misma transacción.
-- Aditiva: columnas nuevas NULL, funciones nuevas; el único recreado es el trigger
-- de alta. Compatible con el código desplegado durante la ventana migrar→deploy.
-- ============================================================================

-- ── 0. Marcador de vinculación autorizada ────────────────────────────────────
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS acceso_autorizado_at  timestamptz,
  ADD COLUMN IF NOT EXISTS acceso_autorizado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL;
COMMENT ON COLUMN usuarios.acceso_autorizado_at IS
  'PKG-06A: un staff autorizó crear el acceso (auth) sobre ESTE perfil sin auth_id aunque tenga historial. Lo consume el trigger de alta.';

-- ── 1. Historial durable ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION cuenta_historial_durable(p_usuario_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_object_agg(k, v) FILTER (WHERE v > 0), '{}'::jsonb)
  FROM (VALUES
    ('membresias',          (SELECT count(*) FROM membresias WHERE usuario_id = p_usuario_id)),
    ('movimientos',         (SELECT count(*) FROM membresia_movimientos WHERE usuario_id = p_usuario_id)),
    ('pagos',               (SELECT count(*) FROM payment_events WHERE usuario_id = p_usuario_id)),
    ('reservas',            (SELECT count(*) FROM reservas WHERE usuario_id = p_usuario_id)),
    ('ventas_mostrador',    (SELECT count(*) FROM ventas_mostrador WHERE usuario_id = p_usuario_id)),
    ('material',            (SELECT count(*) FROM material_sesion WHERE usuario_id = p_usuario_id)),
    ('reversales',          (SELECT count(*) FROM reversales_pago WHERE usuario_id = p_usuario_id)),
    ('operaciones_stripe',  (SELECT count(*) FROM stripe_operaciones_suscripcion WHERE usuario_id = p_usuario_id)),
    ('discrepancias_stripe',(SELECT count(*) FROM discrepancias_stripe WHERE usuario_id = p_usuario_id)),
    ('correos_directos',    (SELECT count(*) FROM correos_directos WHERE usuario_id = p_usuario_id)),
    ('notas',               (SELECT count(*) FROM notas_miembro WHERE miembro_id = p_usuario_id)),
    ('cliente_stripe',      (SELECT count(*) FROM usuarios_datos_privados WHERE usuario_id = p_usuario_id AND stripe_customer_id IS NOT NULL))
  ) AS h(k, v);
$$;
REVOKE ALL ON FUNCTION cuenta_historial_durable(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cuenta_historial_durable(uuid) TO service_role;

-- Huella como STAFF: filas de evidencia donde esta persona es el actor. Las FK sin
-- ON DELETE harían fallar el borrado; las SET NULL dejarían evidencia anónima.
CREATE OR REPLACE FUNCTION _cuenta_huella_staff(p_usuario_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_object_agg(k, v) FILTER (WHERE v > 0), '{}'::jsonb)
  FROM (VALUES
    ('bitacora',            (SELECT count(*) FROM audit_log WHERE actor_usuario_id = p_usuario_id)),
    ('checkins',            (SELECT count(*) FROM reservas WHERE check_in_by = p_usuario_id)),
    ('cancelaciones',       (SELECT count(*) FROM reservas WHERE cancelada_por = p_usuario_id)),
    ('notas_escritas',      (SELECT count(*) FROM notas_miembro WHERE autor_id = p_usuario_id)),
    ('ventas_registradas',  (SELECT count(*) FROM ventas_mostrador WHERE actor_usuario_id = p_usuario_id)),
    ('material_subido',     (SELECT count(*) FROM material_sesion WHERE subido_por = p_usuario_id)),
    ('invitados_registrados',(SELECT count(*) FROM reserva_invitados WHERE created_by = p_usuario_id)),
    ('revisiones',          (SELECT count(*) FROM revisiones_financieras WHERE actor_usuario_id = p_usuario_id)),
    ('eventos_revisados',   (SELECT count(*) FROM stripe_webhook_events WHERE revisado_por = p_usuario_id)),
    ('operaciones_revisadas',(SELECT count(*) FROM stripe_operaciones_suscripcion WHERE revisada_por = p_usuario_id)),
    ('discrepancias_revisadas',(SELECT count(*) FROM discrepancias_stripe WHERE revisada_por = p_usuario_id)),
    ('correos_revisados',   (SELECT count(*) FROM correos_directos WHERE revisado_por = p_usuario_id)
                            + (SELECT count(*) FROM notificaciones WHERE email_revisado_por = p_usuario_id)),
    ('accesos_autorizados', (SELECT count(*) FROM usuarios WHERE acceso_autorizado_por = p_usuario_id))
  ) AS h(k, v);
$$;
REVOKE ALL ON FUNCTION _cuenta_huella_staff(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _cuenta_huella_staff(uuid) TO service_role;

-- ── 2. Actor explícito, validado, publicado en la transacción ────────────────
-- La función de Netlify autentica al caller con su JWT y pasa su `usuarios.id`.
-- Aquí se valida (existe, activo, rol permitido) y se publica su auth_id como
-- `request.jwt.claim.sub` SOLO para esta transacción (is_local = true): así
-- `_audit_actor()` (R1) y `get_my_user_id()` ven a la persona real. El cliente no
-- puede forjarlo: estas RPC no son ejecutables por authenticated/anon.
CREATE OR REPLACE FUNCTION _cuenta_actor(p_actor_id uuid, p_roles text[])
RETURNS usuarios
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_NO_AUTH: Falta el actor de la operación';
  END IF;
  SELECT * INTO v_actor FROM usuarios WHERE id = p_actor_id;
  IF v_actor.id IS NULL OR v_actor.status <> 'activo' OR NOT (v_actor.rol = ANY (p_roles)) THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Esta operación requiere una cuenta activa de %', array_to_string(p_roles, ' o ');
  END IF;
  IF v_actor.auth_id IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_actor.auth_id::text, true);
  END IF;
  RETURN v_actor;
END;
$$;
REVOKE ALL ON FUNCTION _cuenta_actor(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _cuenta_actor(uuid, text[]) TO service_role;

-- Aviso "cambia tu contraseña temporal" (gate de PKG-02C), dentro de la transacción.
CREATE OR REPLACE FUNCTION _cuenta_avisar_cambiar_password(p_tenant_id uuid, p_usuario_id uuid, p_origen text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO notificaciones (tenant_id, usuario_id, tipo, titulo, mensaje, metadata)
  VALUES (p_tenant_id, p_usuario_id, 'cambiar_password', 'Cambia tu contraseña temporal',
          CASE WHEN p_origen = 'alta'
               THEN 'Entraste con la contraseña que te dieron en el estudio. Cámbiala por una tuya desde tu perfil.'
               ELSE 'Te restablecieron la contraseña en el estudio. Cámbiala por una tuya desde tu perfil.' END,
          jsonb_build_object('origen', p_origen));
$$;
REVOKE ALL ON FUNCTION _cuenta_avisar_cambiar_password(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _cuenta_avisar_cambiar_password(uuid, uuid, text) TO service_role;

-- ── 3. Alta en Auth: vincular solo lo elegible (recreada desde 20260925100000) ─
CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id   uuid;
  v_tenant_slug text;
  v_nombre      text;
  v_telefono    text;
  v_email       text;
  v_candidatos  integer;
  v_existente   usuarios;
  v_historial   jsonb;          -- PKG-06A
  v_actor_rol   text;           -- PKG-06A
BEGIN
  v_tenant_slug := COALESCE(NEW.raw_user_meta_data->>'tenant_slug', 'ekko');
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = v_tenant_slug;
  IF v_tenant_id IS NULL THEN
    RAISE NOTICE 'Tenant % no existe, usando ekko como fallback', v_tenant_slug;
    SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'ekko';
  END IF;

  v_email    := lower(trim(NEW.email));
  v_nombre   := NULLIF(trim(NEW.raw_user_meta_data->>'nombre'), '');
  v_telefono := NULLIF(trim(NEW.raw_user_meta_data->>'telefono'), '');

  -- Sin correo no hay identidad que crear ni vincular: el alta en Auth se
  -- revierte con un mensaje claro (antes reventaba por NOT NULL en usuarios).
  IF v_email IS NULL OR v_email = '' OR position('@' IN v_email) = 0 THEN
    RAISE EXCEPTION 'EKKO_EMAIL_INVALIDO: la cuenta de acceso necesita un correo válido (recibido: %)', COALESCE(NEW.email, 'NULL');
  END IF;

  SELECT count(*) INTO v_candidatos
  FROM usuarios
  WHERE tenant_id = v_tenant_id AND lower(trim(email)) = v_email;

  IF v_candidatos = 0 THEN
    INSERT INTO usuarios (auth_id, tenant_id, email, nombre, telefono, rol, status)
    VALUES (NEW.id, v_tenant_id, v_email, v_nombre, v_telefono, 'miembro', 'pendiente_onboarding');
    RETURN NEW;
  END IF;

  IF v_candidatos > 1 THEN
    RAISE EXCEPTION
      'EKKO_IDENTIDAD_AMBIGUA: hay % filas con el correo % en el estudio; resuélvelo antes de crear la cuenta',
      v_candidatos, v_email;
  END IF;

  SELECT * INTO v_existente
  FROM usuarios
  WHERE tenant_id = v_tenant_id AND lower(trim(email)) = v_email;

  -- Ya vinculada a ESTA misma cuenta: idempotente (no hay nada que hacer).
  IF v_existente.auth_id = NEW.id THEN
    RETURN NEW;
  END IF;

  IF v_existente.auth_id IS NOT NULL THEN
    RAISE EXCEPTION
      'EKKO_IDENTIDAD_AMBIGUA: el correo % ya pertenece a otra cuenta de acceso', v_email;
  END IF;

  -- PKG-06A: el correo solo no prueba que el perfil sea de esta identidad. Un
  -- perfil con historial durable (membresías, pagos, reservas, créditos…) se
  -- vincula únicamente si un staff lo autorizó sobre ESE perfil; un cascarón sin
  -- historial sí se vincula (EKKO-095 sigue valiendo para él).
  v_historial := cuenta_historial_durable(v_existente.id);
  IF v_historial <> '{}'::jsonb AND v_existente.acceso_autorizado_at IS NULL THEN
    RAISE EXCEPTION
      'EKKO_PERFIL_CON_HISTORIAL: ya existe un perfil con historial para el correo %; el acceso se crea desde su ficha, con autorización explícita', v_email;
  END IF;

  UPDATE usuarios
  SET auth_id  = NEW.id,
      email    = v_email,
      nombre   = COALESCE(nombre, v_nombre),
      telefono = COALESCE(telefono, v_telefono),
      acceso_autorizado_at  = NULL,
      acceso_autorizado_por = NULL
  WHERE id = v_existente.id;

  SELECT rol INTO v_actor_rol FROM usuarios WHERE id = v_existente.acceso_autorizado_por;
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, metadata)
  VALUES (v_tenant_id, v_existente.acceso_autorizado_por, COALESCE(v_actor_rol, 'sistema'), 'auth_vinculado', 'usuario', v_existente.id,
          jsonb_build_object('auth_id', NEW.id, 'email', v_email,
                             'historial', v_historial,
                             'autorizado_at', v_existente.acceso_autorizado_at));

  RETURN NEW;
END;
$$;

-- ── 4. Alta: preparar (antes de tocar Auth) ──────────────────────────────────
-- Decide, con el estado real, qué va a pasar con ese correo en el tenant del
-- actor: 'nueva' (no hay perfil), 'vincular' (perfil sin acceso: cascarón, o con
-- historial y p_perfil_id explícito → deja el marcador), 'perfil_con_historial'
-- (sin autorización explícita), 'rol_distinto', 'existente' (ya tiene acceso),
-- 'recuperar' (un alta anterior quedó a medias: Auth sí, finalización no) o
-- 'ambiguo'. No crea nada en Auth; no muta salvo el marcador autorizado.
--
-- 'recuperar' está ACOTADO a lo que un alta de 06A deja a medias: un cascarón
-- (miembro/pendiente_onboarding, sin historial, sin evidencia de alta) o un perfil
-- vinculado con autorización explícita (auth_vinculado con autorizado_at) y sin
-- evidencia de alta. Cualquier otra cuenta con acceso es 'existente': nunca se
-- re-finaliza una cuenta real por pedir su correo.
CREATE OR REPLACE FUNCTION cuenta_alta_preparar(p_actor_id uuid, p_email text, p_rol text, p_perfil_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
  v_email text := lower(trim(p_email));
  v_n integer;
  v_perfil usuarios;
  v_hist jsonb;
  v_vinculado_autorizado boolean;
  v_vinculado boolean;
BEGIN
  IF p_rol NOT IN ('miembro', 'recepcionista', 'admin') THEN
    RAISE EXCEPTION 'EKKO_ROL_INVALIDO: Rol no permitido: %', p_rol;
  END IF;
  -- Recepción solo da de alta MIEMBROS; staff solo lo crea un admin.
  v_actor := _cuenta_actor(p_actor_id, CASE WHEN p_rol = 'miembro' THEN ARRAY['admin', 'recepcionista'] ELSE ARRAY['admin'] END);
  IF v_email IS NULL OR position('@' IN v_email) = 0 THEN
    RAISE EXCEPTION 'EKKO_EMAIL_INVALIDO: Email inválido';
  END IF;

  SELECT count(*) INTO v_n FROM usuarios WHERE tenant_id = v_actor.tenant_id AND lower(trim(email)) = v_email;
  IF v_n = 0 THEN
    IF p_perfil_id IS NOT NULL THEN
      RAISE EXCEPTION 'EKKO_PERFIL_DISTINTO: El perfil indicado no tiene ese correo';
    END IF;
    RETURN jsonb_build_object('modo', 'nueva', 'tenant_id', v_actor.tenant_id);
  END IF;
  IF v_n > 1 THEN
    RETURN jsonb_build_object('modo', 'ambiguo', 'tenant_id', v_actor.tenant_id);
  END IF;

  SELECT * INTO v_perfil FROM usuarios WHERE tenant_id = v_actor.tenant_id AND lower(trim(email)) = v_email FOR UPDATE;
  IF v_perfil.auth_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM audit_log
               WHERE target_tipo = 'usuario' AND target_id = v_perfil.id
                 AND accion IN ('cuenta_creada', 'acceso_creado')
                 AND metadata->>'auth_id' = v_perfil.auth_id::text) THEN
      RETURN jsonb_build_object('modo', 'existente', 'perfil_id', v_perfil.id, 'tenant_id', v_actor.tenant_id);
    END IF;
    v_hist := cuenta_historial_durable(v_perfil.id);
    SELECT EXISTS (SELECT 1 FROM audit_log a
                   WHERE a.target_tipo = 'usuario' AND a.target_id = v_perfil.id AND a.accion = 'auth_vinculado'
                     AND a.metadata->>'auth_id' = v_perfil.auth_id::text),
           EXISTS (SELECT 1 FROM audit_log a
                   WHERE a.target_tipo = 'usuario' AND a.target_id = v_perfil.id AND a.accion = 'auth_vinculado'
                     AND a.metadata->>'auth_id' = v_perfil.auth_id::text AND a.metadata->>'autorizado_at' IS NOT NULL)
      INTO v_vinculado, v_vinculado_autorizado;
    IF v_hist = '{}'::jsonb AND v_perfil.rol = 'miembro' AND v_perfil.status = 'pendiente_onboarding' THEN
      -- Cascarón de un alta a medias: se finaliza con el modo con que empezó.
      IF v_vinculado AND v_perfil.rol <> p_rol THEN
        RETURN jsonb_build_object('modo', 'rol_distinto', 'perfil_id', v_perfil.id, 'rol_perfil', v_perfil.rol, 'tenant_id', v_actor.tenant_id);
      END IF;
      RETURN jsonb_build_object('modo', 'recuperar', 'modo_original', CASE WHEN v_vinculado THEN 'vincular' ELSE 'nueva' END,
                                'perfil_id', v_perfil.id, 'auth_id', v_perfil.auth_id, 'tenant_id', v_actor.tenant_id);
    END IF;
    IF v_vinculado_autorizado THEN
      IF v_perfil.rol <> p_rol THEN
        RETURN jsonb_build_object('modo', 'rol_distinto', 'perfil_id', v_perfil.id, 'rol_perfil', v_perfil.rol, 'tenant_id', v_actor.tenant_id);
      END IF;
      RETURN jsonb_build_object('modo', 'recuperar', 'modo_original', 'vincular',
                                'perfil_id', v_perfil.id, 'auth_id', v_perfil.auth_id, 'tenant_id', v_actor.tenant_id);
    END IF;
    RETURN jsonb_build_object('modo', 'existente', 'perfil_id', v_perfil.id, 'tenant_id', v_actor.tenant_id);
  END IF;
  IF p_perfil_id IS NOT NULL AND p_perfil_id <> v_perfil.id THEN
    RAISE EXCEPTION 'EKKO_PERFIL_DISTINTO: El perfil indicado no corresponde a ese correo';
  END IF;
  -- Al vincular no se reescribe el rol del perfil existente: si el alta pide otro,
  -- se rechaza ANTES de crear nada en Auth.
  IF v_perfil.rol <> p_rol THEN
    RETURN jsonb_build_object('modo', 'rol_distinto', 'perfil_id', v_perfil.id, 'rol_perfil', v_perfil.rol, 'tenant_id', v_actor.tenant_id);
  END IF;

  v_hist := cuenta_historial_durable(v_perfil.id);
  IF v_hist <> '{}'::jsonb THEN
    IF p_perfil_id IS NULL THEN
      RETURN jsonb_build_object('modo', 'perfil_con_historial', 'perfil_id', v_perfil.id, 'historial', v_hist, 'tenant_id', v_actor.tenant_id);
    END IF;
    -- Autorización explícita sobre ESTE perfil: marcador durable + evidencia con actor.
    UPDATE usuarios SET acceso_autorizado_at = now(), acceso_autorizado_por = v_actor.id WHERE id = v_perfil.id;
    INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, metadata)
    VALUES (v_actor.tenant_id, v_actor.id, v_actor.rol, 'acceso_autorizado', 'usuario', v_perfil.id,
            jsonb_build_object('historial', v_hist));
  END IF;
  RETURN jsonb_build_object('modo', 'vincular', 'perfil_id', v_perfil.id, 'historial', v_hist, 'tenant_id', v_actor.tenant_id);
END;
$$;
REVOKE ALL ON FUNCTION cuenta_alta_preparar(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cuenta_alta_preparar(uuid, text, text, uuid) TO service_role;

-- ── 5. Alta: finalizar (después de Auth) — una transacción ───────────────────
-- 'nueva': el trigger dejó un cascarón miembro/pendiente_onboarding → se fijan rol,
-- status, plan, nombre y teléfono. 'vincular': el perfil conserva rol, status y
-- plan (solo se completan nombre/teléfono vacíos). En ambos: aviso de cambiar la
-- contraseña + auditoría con actor. Idempotente: si ya hay evidencia de alta para
-- este auth_id, no repite nada.
CREATE OR REPLACE FUNCTION cuenta_alta_finalizar(
  p_actor_id uuid, p_auth_id uuid, p_rol text, p_tier text, p_nombre text, p_telefono text, p_modo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
  v_u usuarios;
  v_status text;
  v_accion text;
BEGIN
  IF p_rol NOT IN ('miembro', 'recepcionista', 'admin') THEN
    RAISE EXCEPTION 'EKKO_ROL_INVALIDO: Rol no permitido: %', p_rol;
  END IF;
  IF p_modo NOT IN ('nueva', 'vincular') THEN
    RAISE EXCEPTION 'EKKO_MODO_INVALIDO: modo % desconocido', p_modo;
  END IF;
  v_actor := _cuenta_actor(p_actor_id, CASE WHEN p_rol = 'miembro' THEN ARRAY['admin', 'recepcionista'] ELSE ARRAY['admin'] END);

  SELECT * INTO v_u FROM usuarios WHERE auth_id = p_auth_id FOR UPDATE;
  IF v_u.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_PERFIL_NO_ENCONTRADO: La cuenta de acceso no quedó vinculada a ningún perfil';
  END IF;
  IF v_u.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'EKKO_TENANT_DIFERENTE: El perfil es de otro estudio';
  END IF;

  IF EXISTS (SELECT 1 FROM audit_log
             WHERE target_tipo = 'usuario' AND target_id = v_u.id
               AND accion IN ('cuenta_creada', 'acceso_creado')
               AND metadata->>'auth_id' = p_auth_id::text) THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'usuario_id', v_u.id, 'rol', v_u.rol, 'status', v_u.status);
  END IF;

  IF p_modo = 'nueva' THEN
    v_status := CASE WHEN p_rol = 'miembro' THEN 'pendiente_pago' ELSE 'activo' END;
    UPDATE usuarios
    SET rol = p_rol,
        status = v_status,
        membresia_tier = CASE WHEN p_rol = 'miembro' THEN p_tier ELSE NULL END,
        nombre = COALESCE(NULLIF(trim(p_nombre), ''), nombre),
        telefono = COALESCE(NULLIF(trim(p_telefono), ''), telefono)
    WHERE id = v_u.id;
    v_accion := 'cuenta_creada';
  ELSE
    IF v_u.rol <> p_rol THEN
      RAISE EXCEPTION 'EKKO_ROL_DISTINTO: El perfil existente es % y no se reescribe al vincular', v_u.rol;
    END IF;
    UPDATE usuarios
    SET nombre = COALESCE(nombre, NULLIF(trim(p_nombre), '')),
        telefono = COALESCE(telefono, NULLIF(trim(p_telefono), ''))
    WHERE id = v_u.id;
    v_accion := 'acceso_creado';
  END IF;
  SELECT * INTO v_u FROM usuarios WHERE id = v_u.id;

  PERFORM _cuenta_avisar_cambiar_password(v_u.tenant_id, v_u.id, 'alta');

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, despues, metadata)
  VALUES (v_u.tenant_id, v_actor.id, v_actor.rol, v_accion, 'usuario', v_u.id,
          jsonb_build_object('rol', v_u.rol, 'status', v_u.status, 'membresia_tier', v_u.membresia_tier),
          jsonb_build_object('auth_id', p_auth_id, 'modo', p_modo));

  RETURN jsonb_build_object('success', true, 'idempotente', false, 'usuario_id', v_u.id, 'rol', v_u.rol, 'status', v_u.status);
END;
$$;
REVOKE ALL ON FUNCTION cuenta_alta_finalizar(uuid, uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cuenta_alta_finalizar(uuid, uuid, text, text, text, text, text) TO service_role;

-- Cuenta de Auth sin ningún perfil (resto de una compensación anterior que no
-- terminó). La función de alta la limpia antes de volver a crear: nada cascadea
-- (todas las FK de negocio apuntan a usuarios.id, y no hay fila).
CREATE OR REPLACE FUNCTION auth_usuario_sin_perfil(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id FROM auth.users a
  WHERE lower(trim(a.email)) = lower(trim(p_email))
    AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.auth_id = a.id)
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION auth_usuario_sin_perfil(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION auth_usuario_sin_perfil(text) TO service_role;

-- ── 6. Cambio de rol: una transacción con actor ──────────────────────────────
-- El invariante del último admin lo sigue imponiendo el trigger de `usuarios`
-- (20260921100000); aquí no hay un segundo conteo: su EKKO_ULTIMO_ADMIN sube.
CREATE OR REPLACE FUNCTION cuenta_cambiar_rol(p_actor_id uuid, p_usuario_id uuid, p_rol text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
  v_t usuarios;
  v_status text;
  v_despues usuarios;
BEGIN
  IF p_rol NOT IN ('miembro', 'recepcionista', 'admin') THEN
    RAISE EXCEPTION 'EKKO_ROL_INVALIDO: Rol no permitido: %', p_rol;
  END IF;
  v_actor := _cuenta_actor(p_actor_id, ARRAY['admin']);
  SELECT * INTO v_t FROM usuarios WHERE id = p_usuario_id FOR UPDATE;
  IF v_t.id IS NULL OR v_t.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Usuario no encontrado o de otro estudio';
  END IF;
  IF v_t.id = v_actor.id THEN
    RAISE EXCEPTION 'EKKO_PROPIO_ROL: No puedes cambiar tu propio rol. Pídeselo a otro admin.';
  END IF;
  IF v_t.rol = p_rol THEN
    RETURN jsonb_build_object('success', true, 'idempotente', true, 'usuario_id', v_t.id, 'rol', v_t.rol, 'status', v_t.status);
  END IF;

  -- Ascender a staff a quien seguía en `pendiente_*` lo deja activo (los poderes de
  -- staff exigen status='activo'). Un revocado/suspendido NO se reactiva por el rol.
  v_status := v_t.status;
  IF p_rol IN ('admin', 'recepcionista') AND v_t.status IN ('pendiente_onboarding', 'pendiente_pago') THEN
    v_status := 'activo';
  END IF;

  UPDATE usuarios SET rol = p_rol, status = v_status WHERE id = v_t.id;
  SELECT * INTO v_despues FROM usuarios WHERE id = v_t.id;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues)
  VALUES (v_t.tenant_id, v_actor.id, v_actor.rol, 'rol_cambiado', 'usuario', v_t.id,
          jsonb_build_object('rol', v_t.rol, 'status', v_t.status),
          jsonb_build_object('rol', v_despues.rol, 'status', v_despues.status));

  RETURN jsonb_build_object('success', true, 'idempotente', false, 'usuario_id', v_t.id, 'rol', v_despues.rol, 'status', v_despues.status);
END;
$$;
REVOKE ALL ON FUNCTION cuenta_cambiar_rol(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cuenta_cambiar_rol(uuid, uuid, text) TO service_role;

-- ── 7. Borrado físico: D-FIN-1 = A ───────────────────────────────────────────
-- Con historial durable o huella como staff NO se borra: `permitido=false` con el
-- detalle (la función responde 409 y manda a "Revocar acceso"). Si se permite:
-- evidencia `cuenta_eliminada` (target_id sin FK: sobrevive; sin PII) y DELETE de
-- la fila local en la misma transacción. La cuenta de Auth la borra después la
-- función; si eso falla, la fila local ya no existe y `auth_usuario_sin_perfil`
-- permite limpiarla en el siguiente alta con ese correo.
CREATE OR REPLACE FUNCTION cuenta_eliminar(p_actor_id uuid, p_usuario_id uuid, p_motivo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
  v_t usuarios;
  v_hist jsonb;
  v_huella jsonb;
BEGIN
  v_actor := _cuenta_actor(p_actor_id, ARRAY['admin']);
  SELECT * INTO v_t FROM usuarios WHERE id = p_usuario_id FOR UPDATE;
  IF v_t.id IS NULL OR v_t.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Usuario no encontrado o de otro estudio';
  END IF;
  IF v_t.id = v_actor.id THEN
    RAISE EXCEPTION 'EKKO_PROPIO: No puedes eliminarte a ti mismo';
  END IF;
  IF v_t.rol = 'admin' AND v_t.status = 'activo' AND count_admins_activos(v_t.tenant_id) <= 1 THEN
    RAISE EXCEPTION 'EKKO_ULTIMO_ADMIN: No puedes borrar al único admin activo del estudio. Nombra otro admin primero.';
  END IF;

  v_hist := cuenta_historial_durable(v_t.id);
  v_huella := _cuenta_huella_staff(v_t.id);
  IF v_hist <> '{}'::jsonb OR v_huella <> '{}'::jsonb THEN
    RETURN jsonb_build_object('permitido', false, 'usuario_id', v_t.id, 'historial', v_hist, 'huella_staff', v_huella);
  END IF;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, motivo, metadata)
  VALUES (v_t.tenant_id, v_actor.id, v_actor.rol, 'cuenta_eliminada', 'usuario', v_t.id,
          jsonb_build_object('rol', v_t.rol, 'status', v_t.status, 'created_at', v_t.created_at),
          NULLIF(trim(p_motivo), ''),
          jsonb_build_object('auth_id', v_t.auth_id, 'tenia_acceso', v_t.auth_id IS NOT NULL));

  DELETE FROM usuarios WHERE id = v_t.id;

  RETURN jsonb_build_object('permitido', true, 'usuario_id', v_t.id, 'auth_id', v_t.auth_id);
END;
$$;
REVOKE ALL ON FUNCTION cuenta_eliminar(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cuenta_eliminar(uuid, uuid, text) TO service_role;

-- ── 8. Contraseña reseteada: evidencia + aviso en una transacción ────────────
-- Se llama DESPUÉS de que Auth aceptó la nueva contraseña (eso no es transaccional
-- con Postgres). Nunca recibe ni guarda la contraseña.
CREATE OR REPLACE FUNCTION cuenta_password_reseteada(p_actor_id uuid, p_usuario_id uuid, p_motivo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
  v_t usuarios;
BEGIN
  v_actor := _cuenta_actor(p_actor_id, ARRAY['admin', 'recepcionista']);
  SELECT * INTO v_t FROM usuarios WHERE id = p_usuario_id;
  IF v_t.id IS NULL OR v_t.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro no encontrado o de otro estudio';
  END IF;
  IF v_t.auth_id IS NULL THEN
    RAISE EXCEPTION 'EKKO_SIN_ACCESO: Esta cuenta no tiene acceso creado todavía';
  END IF;
  IF v_t.rol <> 'miembro' AND v_actor.rol <> 'admin' THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede resetear la contraseña del equipo';
  END IF;

  PERFORM _cuenta_avisar_cambiar_password(v_t.tenant_id, v_t.id, 'reset');
  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, motivo)
  VALUES (v_t.tenant_id, v_actor.id, v_actor.rol, 'password_reset', 'usuario', v_t.id, NULLIF(trim(p_motivo), ''));
  RETURN jsonb_build_object('success', true, 'usuario_id', v_t.id);
END;
$$;
REVOKE ALL ON FUNCTION cuenta_password_reseteada(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cuenta_password_reseteada(uuid, uuid, text) TO service_role;

-- ── 9. Edición de cuenta por staff: la parte local en una transacción ────────
-- p_cambios: { nombre?, telefono?, email?, status?, unblock?, avatar_url? }.
--  · status 'suspendido' = sanción (sancionado_at + motivo); 'activo' o
--    'pendiente_pago' la levantan; sobre un revocado exige admin y pasa por
--    `restaurar_acceso_revocado` (R1) en la MISMA transacción, después de
--    levantar la sanción. El trigger `usuarios_sancion_manda` sigue mandando y el
--    audit registra el estado REAL. Las operaciones de cobro (R2-B/EKKO-138/02H)
--    las crean los triggers de siempre; aquí no se toca Stripe.
--  · email: SOLO la copia local, y la función la llama después de que Auth aceptó
--    el cambio (si Auth falla, la copia local no se toca y el reintento converge).
--  · avatar_url: `identidad_completa` la recalcula el trigger (EKKO-094).
CREATE OR REPLACE FUNCTION staff_actualizar_cuenta(p_actor_id uuid, p_usuario_id uuid, p_cambios jsonb, p_motivo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor usuarios;
  v_t usuarios;
  v_motivo text := NULLIF(trim(COALESCE(p_motivo, '')), '');
  v_cambios text[] := ARRAY[]::text[];
  v_status_nuevo text := NULLIF(p_cambios->>'status', '');
  v_unblock boolean := false;
  v_restaurar boolean := false;
  v_sancionar boolean;
  v_nombre text := NULLIF(trim(COALESCE(p_cambios->>'nombre', '')), '');
  v_telefono text;
  v_email text := NULLIF(lower(trim(COALESCE(p_cambios->>'email', ''))), '');
  v_avatar text := NULLIF(p_cambios->>'avatar_url', '');
  v_contacto_antes jsonb := '{}'::jsonb;
  v_contacto_despues jsonb := '{}'::jsonb;
  v_final usuarios;
BEGIN
  v_actor := _cuenta_actor(p_actor_id, ARRAY['admin', 'recepcionista']);
  SELECT * INTO v_t FROM usuarios WHERE id = p_usuario_id FOR UPDATE;
  IF v_t.id IS NULL OR v_t.tenant_id <> v_actor.tenant_id THEN
    RAISE EXCEPTION 'EKKO_MIEMBRO_INVALIDO: Miembro no encontrado o de otro estudio';
  END IF;
  -- Recepción solo edita MIEMBROS; las cuentas del equipo las toca un admin.
  IF v_t.rol <> 'miembro' AND v_actor.rol <> 'admin' THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede modificar las cuentas del equipo';
  END IF;
  IF p_cambios ? 'membresia_tier' THEN
    RAISE EXCEPTION 'EKKO_PLAN_NO_EDITABLE: El plan no se cambia desde "Editar datos": actívalo con cobro desde la tarjeta de membresía';
  END IF;

  IF v_status_nuevo = v_t.status THEN v_status_nuevo := NULL; END IF;
  IF v_status_nuevo IS NOT NULL AND v_status_nuevo NOT IN ('activo', 'suspendido', 'pendiente_pago') THEN
    RAISE EXCEPTION 'EKKO_STATUS_INVALIDO: Status no permitido: %', v_status_nuevo;
  END IF;
  v_unblock := COALESCE((p_cambios->>'unblock')::boolean, false)
               AND (v_t.bloqueado_hasta IS NOT NULL OR COALESCE(v_t.no_shows_count, 0) > 0);
  IF (v_status_nuevo IS NOT NULL OR v_unblock) AND COALESCE(length(v_motivo), 0) < 3 THEN
    RAISE EXCEPTION 'EKKO_MOTIVO_REQUERIDO: Motivo obligatorio para esta acción';
  END IF;

  -- Revocación (R1): persistente; solo un admin la restaura y solo por la RPC.
  v_restaurar := v_t.status = 'revocado' AND v_status_nuevo IS NOT NULL AND v_status_nuevo <> 'suspendido';
  IF v_restaurar AND v_actor.rol <> 'admin' THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede restaurar un acceso revocado';
  END IF;

  -- Contacto (sin motivo).
  IF v_nombre IS NOT NULL AND v_nombre <> COALESCE(v_t.nombre, '') THEN
    v_contacto_antes := v_contacto_antes || jsonb_build_object('nombre', v_t.nombre);
    v_contacto_despues := v_contacto_despues || jsonb_build_object('nombre', v_nombre);
    v_cambios := array_append(v_cambios, 'nombre');
  ELSE
    v_nombre := v_t.nombre;
  END IF;
  IF p_cambios ? 'telefono' AND trim(COALESCE(p_cambios->>'telefono', '')) <> COALESCE(v_t.telefono, '') THEN
    v_telefono := NULLIF(trim(COALESCE(p_cambios->>'telefono', '')), '');
    v_contacto_antes := v_contacto_antes || jsonb_build_object('telefono', v_t.telefono);
    v_contacto_despues := v_contacto_despues || jsonb_build_object('telefono', v_telefono);
    v_cambios := array_append(v_cambios, 'teléfono');
  ELSE
    v_telefono := v_t.telefono;
  END IF;
  IF v_email IS NOT NULL AND v_email <> lower(COALESCE(v_t.email, '')) THEN
    IF position('@' IN v_email) = 0 THEN
      RAISE EXCEPTION 'EKKO_EMAIL_INVALIDO: Email inválido';
    END IF;
    v_contacto_antes := v_contacto_antes || jsonb_build_object('email', v_t.email);
    v_contacto_despues := v_contacto_despues || jsonb_build_object('email', v_email);
    v_cambios := array_append(v_cambios, 'email');
  ELSE
    v_email := v_t.email;
  END IF;

  IF v_status_nuevo IS NOT NULL THEN v_cambios := array_append(v_cambios, 'status→' || v_status_nuevo); END IF;
  IF v_unblock THEN v_cambios := array_append(v_cambios, 'desbloqueo'); END IF;
  IF v_avatar IS NOT NULL THEN v_cambios := array_append(v_cambios, 'foto'); END IF;

  IF cardinality(v_cambios) = 0 THEN
    RETURN jsonb_build_object('success', true, 'sin_cambios', true, 'cambios', '[]'::jsonb, 'status', v_t.status);
  END IF;

  v_sancionar := v_status_nuevo = 'suspendido';
  UPDATE usuarios
  SET nombre = v_nombre,
      telefono = v_telefono,
      email = v_email,
      avatar_url = COALESCE(v_avatar, avatar_url),
      bloqueado_hasta = CASE WHEN v_unblock THEN NULL ELSE bloqueado_hasta END,
      -- Sin status en el UPDATE cuando se restaura: lo pone la RPC de R1.
      status = CASE WHEN v_status_nuevo IS NOT NULL AND NOT v_restaurar THEN v_status_nuevo ELSE status END,
      sancionado_at = CASE WHEN v_status_nuevo IS NULL THEN sancionado_at WHEN v_sancionar THEN now() ELSE NULL END,
      sancion_motivo = CASE WHEN v_status_nuevo IS NULL THEN sancion_motivo WHEN v_sancionar THEN v_motivo ELSE NULL END
  WHERE id = v_t.id;

  IF v_restaurar THEN
    PERFORM restaurar_acceso_revocado(v_t.id, v_actor.id, v_status_nuevo, v_motivo);
  END IF;

  SELECT * INTO v_final FROM usuarios WHERE id = v_t.id;

  IF v_status_nuevo IS NOT NULL THEN
    INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo)
    VALUES (v_t.tenant_id, v_actor.id, v_actor.rol, 'status_change', 'usuario', v_t.id,
            jsonb_build_object('status', v_t.status, 'sancionado', v_t.sancionado_at IS NOT NULL),
            jsonb_build_object('status', v_final.status, 'sancionado', v_final.sancionado_at IS NOT NULL),
            v_motivo);
  END IF;
  IF v_unblock THEN
    INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo)
    VALUES (v_t.tenant_id, v_actor.id, v_actor.rol, 'unblock', 'usuario', v_t.id,
            jsonb_build_object('bloqueado_hasta', v_t.bloqueado_hasta, 'no_shows_count', COALESCE(v_t.no_shows_count, 0)),
            jsonb_build_object('bloqueado_hasta', NULL, 'no_shows_count', COALESCE(v_t.no_shows_count, 0)),
            v_motivo);
  END IF;
  IF v_avatar IS NOT NULL THEN
    INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, despues)
    VALUES (v_t.tenant_id, v_actor.id, v_actor.rol, 'avatar_change', 'usuario', v_t.id, jsonb_build_object('avatar_url', v_avatar));
  END IF;
  IF v_contacto_despues <> '{}'::jsonb THEN
    INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, antes, despues, motivo)
    VALUES (v_t.tenant_id, v_actor.id, v_actor.rol, 'contact_change', 'usuario', v_t.id, v_contacto_antes, v_contacto_despues, v_motivo);
  END IF;

  RETURN jsonb_build_object('success', true, 'sin_cambios', false, 'cambios', to_jsonb(v_cambios),
                            'status', v_final.status, 'avatar_url', v_final.avatar_url);
END;
$$;
REVOKE ALL ON FUNCTION staff_actualizar_cuenta(uuid, uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION staff_actualizar_cuenta(uuid, uuid, jsonb, text) TO service_role;
