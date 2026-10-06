-- ============================================================================
-- PKG-06C · Alta pública con correo verificado (FR-24, EKKO-146, D-FIN-6 = A)
-- ============================================================================
-- El registro público sigue abierto, pero escribir un correo ya no prueba nada:
--
--  1. `handle_new_auth_user` (recreada desde su última definición, 06A) NO crea ni
--     vincula identidad EKKO mientras el correo de la cuenta de Auth no esté
--     confirmado. La misma función se engancha además a la CONFIRMACIÓN
--     (`on_auth_user_confirmed`: email_confirmed_at pasa de NULL a un valor), que es
--     el momento en que el proveedor de Auth comprobó que el dueño del buzón abrió
--     el enlace. Las altas del staff (createUser con email_confirm=true) nacen
--     confirmadas y siguen exactamente igual que en 06A.
--     Para un alta pública (`origen = 'alta_publica'`, metadata que solo escribe el
--     servidor) el perfil nuevo nace `miembro` / `pendiente_pago`, con el plan
--     elegido solo si sigue activo y en venta; nada de rol, créditos, membresía ni
--     estudio sale de la metadata. Vincular un perfil existente sigue las reglas de
--     06A (cascarón sin historial o acceso autorizado; sin reescribir rol, status ni
--     plan) y, además, el alta pública nunca vincula un perfil de staff.
--  2. `alta_publica_intentos`: límite de tasa durable, solo con huellas HMAC (sin
--     correo ni IP en claro) y una ventana de 24 h que se purga sola.
--  3. `alta_publica_solicitar` (solo service_role): en UNA transacción aplica el
--     límite, valida el plan y clasifica el correo con el estado real (crear, mandar
--     enlace o no hacer nada). La respuesta pública de la function es la misma en
--     todos los casos (sin enumeración); esta clasificación nunca sale del servidor.
--
-- Aditiva: el código viejo (fake-signup con email_confirm=true) sigue funcionando
-- sobre esta base igual que antes (sus cuentas nacen confirmadas).
-- ============================================================================


-- ── 1. Límite de tasa durable ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alta_publica_intentos (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- HMAC-SHA256 (hex) del correo normalizado y del origen de red, calculado en el
  -- servidor con una llave que no vive en la base: aquí no hay datos en claro.
  clave_correo text NOT NULL CHECK (clave_correo ~ '^[0-9a-f]{64}$'),
  clave_origen text CHECK (clave_origen IS NULL OR clave_origen ~ '^[0-9a-f]{64}$'),
  creado_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE alta_publica_intentos IS
  'PKG-06C: solicitudes de alta pública aceptadas por el límite de tasa (24 h, se purga sola). Solo huellas HMAC; sin correo, IP ni token.';

CREATE INDEX IF NOT EXISTS alta_publica_intentos_correo_idx ON alta_publica_intentos (clave_correo, creado_at);
CREATE INDEX IF NOT EXISTS alta_publica_intentos_origen_idx ON alta_publica_intentos (clave_origen, creado_at) WHERE clave_origen IS NOT NULL;
CREATE INDEX IF NOT EXISTS alta_publica_intentos_tenant_idx ON alta_publica_intentos (tenant_id, creado_at);

ALTER TABLE alta_publica_intentos ENABLE ROW LEVEL SECURITY;
-- Sin políticas: ningún cliente la lee ni la escribe. Solo la RPC (DEFINER).
REVOKE ALL ON alta_publica_intentos FROM PUBLIC, anon, authenticated, service_role;


-- ── 2. Alta en Auth: sin correo verificado no hay identidad EKKO ────────────
-- Recreada desde 20261013100000_06a_cuentas_compuestas.sql:151. Cambios PKG-06C
-- marcados; la lógica de 06A (vincular, ambigüedad, historial) queda intacta.
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
  v_publica     boolean;        -- PKG-06C
  v_plan        text;           -- PKG-06C
  v_nuevo       uuid;           -- PKG-06C
BEGIN
  -- PKG-06C: una cuenta de Auth cuyo correo nadie ha confirmado no recibe identidad
  -- EKKO (ni perfil nuevo ni vinculación por correo). Esta misma función corre otra
  -- vez cuando el proveedor confirma el correo (trigger on_auth_user_confirmed).
  IF NEW.email_confirmed_at IS NULL THEN
    RETURN NEW;
  END IF;

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

  -- PKG-06C: idempotente. Una confirmación repetida (o la confirmación de una
  -- cuenta que ya tiene perfil) no crea ni vincula nada más.
  IF EXISTS (SELECT 1 FROM usuarios WHERE auth_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- PKG-06C: alta pública. `origen` y `plan` los escribe solo la function del
  -- servidor (el registro directo en Auth está apagado); aun así se tratan como no
  -- confiables: el plan se revalida y nada más de la metadata se usa.
  v_publica := COALESCE(NEW.raw_user_meta_data->>'origen', '') = 'alta_publica';
  IF v_publica THEN
    v_tenant_id := (SELECT id FROM tenants WHERE slug = 'ekko');
    v_nombre    := left(v_nombre, 120);
    v_telefono  := NULL;
    SELECT t.slug INTO v_plan
    FROM tiers t
    WHERE t.tenant_id = v_tenant_id
      AND t.slug = NEW.raw_user_meta_data->>'plan'
      AND t.activo AND t.en_venta;
  END IF;

  SELECT count(*) INTO v_candidatos
  FROM usuarios
  WHERE tenant_id = v_tenant_id AND lower(trim(email)) = v_email;

  IF v_candidatos = 0 THEN
    IF v_publica THEN
      -- PKG-06C: miembro sin derechos; paga desde la app (pendiente_pago).
      INSERT INTO usuarios (auth_id, tenant_id, email, nombre, telefono, rol, status, membresia_tier, notas_admin)
      VALUES (NEW.id, v_tenant_id, v_email, v_nombre, NULL, 'miembro', 'pendiente_pago', v_plan,
              'Alta por registro público con correo verificado — pendiente de pago')
      RETURNING id INTO v_nuevo;
      INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, metadata)
      VALUES (v_tenant_id, NULL, 'sistema', 'alta_publica_verificada', 'usuario', v_nuevo,
              jsonb_build_object('auth_id', NEW.id, 'plan', v_plan));
      RETURN NEW;
    END IF;
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

  -- PKG-06C: el registro público nunca da acceso a un perfil de staff, aunque el
  -- correo esté verificado: el acceso del equipo lo crea un admin.
  IF v_publica AND v_existente.rol IS DISTINCT FROM 'miembro' THEN
    RAISE EXCEPTION
      'EKKO_ALTA_PUBLICA_PERFIL_STAFF: el correo % pertenece a un perfil del equipo; su acceso lo crea un admin', v_email;
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
                             'autorizado_at', v_existente.acceso_autorizado_at,
                             'origen', CASE WHEN v_publica THEN 'alta_publica' ELSE 'staff' END));  -- PKG-06C

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION handle_new_auth_user() FROM PUBLIC, anon, authenticated;

-- La confirmación del correo (el proveedor marca email_confirmed_at) es el único
-- momento en que una cuenta pendiente recibe identidad EKKO. Si la vinculación no
-- es segura (historial sin autorizar, perfil de staff, ambigüedad), la excepción
-- revierte la confirmación completa: nunca queda un correo "verificado" a medias.
DROP TRIGGER IF EXISTS on_auth_user_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_confirmed
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION handle_new_auth_user();


-- ── 3. Solicitud de alta pública (límite + clasificación) ──────────────────
CREATE OR REPLACE FUNCTION alta_publica_solicitar(
  p_email        text,
  p_clave_correo text,
  p_clave_origen text,
  p_tier         text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Umbrales (PKG-06C). Por correo: no más de 1 enlace por minuto ni 5 al día
  -- (protege el buzón; excedido = silencio, no error: no delata nada). Por origen
  -- de red: 5 en 10 min y 20 al día. Del estudio entero: 60 por hora (techo ante
  -- bots distribuidos). Solo cuentan las solicitudes ACEPTADAS: insistir por encima
  -- del límite no alarga el bloqueo.
  c_correo_cooldown constant interval := interval '60 seconds';
  c_correo_dia      constant integer  := 5;
  c_origen_rafaga   constant integer  := 5;
  c_origen_ventana  constant interval := interval '10 minutes';
  c_origen_dia      constant integer  := 20;
  c_global_hora     constant integer  := 60;

  v_email     text := lower(trim(COALESCE(p_email, '')));
  v_tenant_id uuid;
  v_plan      text;
  v_auth_id   uuid;
  v_conf      timestamptz;
  v_pwd       text;
  v_n         integer;
  v_perfil    usuarios;
  v_hist      jsonb;
BEGIN
  IF v_email = '' OR length(v_email) > 254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'EKKO_CORREO_INVALIDO: Ingresa un correo válido.';
  END IF;
  IF p_clave_correo IS NULL OR p_clave_correo !~ '^[0-9a-f]{64}$'
     OR (p_clave_origen IS NOT NULL AND p_clave_origen !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'EKKO_SOLICITUD_INVALIDA: solicitud de alta mal formada';
  END IF;

  -- Un solo estudio hoy (fallback aceptado hasta multitenencia): lo fija el
  -- servidor, nunca el navegador.
  SELECT id INTO v_tenant_id FROM tenants WHERE slug = 'ekko';
  SELECT t.slug INTO v_plan
  FROM tiers t
  WHERE t.tenant_id = v_tenant_id AND t.slug = p_tier AND t.activo AND t.en_venta;
  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'EKKO_PLAN_NO_DISPONIBLE: Ese plan ya no está disponible. Elige otro.';
  END IF;

  -- Serializa las solicitudes: los conteos no se pisan (doble clic, ráfagas).
  PERFORM pg_advisory_xact_lock(hashtext('ekko:alta_publica'));

  DELETE FROM alta_publica_intentos WHERE creado_at < now() - interval '24 hours';

  SELECT count(*) INTO v_n FROM alta_publica_intentos
  WHERE tenant_id = v_tenant_id AND creado_at > now() - interval '1 hour';
  IF v_n >= c_global_hora THEN
    RETURN jsonb_build_object('resultado', 'limitado', 'alcance', 'global');
  END IF;

  IF p_clave_origen IS NOT NULL THEN
    IF (SELECT count(*) FROM alta_publica_intentos
        WHERE clave_origen = p_clave_origen AND creado_at > now() - c_origen_ventana) >= c_origen_rafaga
       OR (SELECT count(*) FROM alta_publica_intentos
           WHERE clave_origen = p_clave_origen) >= c_origen_dia THEN
      RETURN jsonb_build_object('resultado', 'limitado', 'alcance', 'origen');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM alta_publica_intentos
             WHERE clave_correo = p_clave_correo AND creado_at > now() - c_correo_cooldown)
     OR (SELECT count(*) FROM alta_publica_intentos WHERE clave_correo = p_clave_correo) >= c_correo_dia THEN
    RETURN jsonb_build_object('resultado', 'silencio');
  END IF;

  INSERT INTO alta_publica_intentos (tenant_id, clave_correo, clave_origen)
  VALUES (v_tenant_id, p_clave_correo, p_clave_origen);

  -- Clasificación con el estado real. Nada de esto viaja al navegador.
  SELECT a.id, a.email_confirmed_at, a.encrypted_password
  INTO v_auth_id, v_conf, v_pwd
  FROM auth.users a
  WHERE lower(trim(a.email)) = v_email
  ORDER BY a.created_at
  LIMIT 1;

  IF v_auth_id IS NOT NULL THEN
    IF v_conf IS NULL THEN
      -- Alta pendiente (de quien sea): el enlace va al buzón; solo su dueño lo usa.
      RETURN jsonb_build_object('resultado', 'ok', 'accion', 'enlace', 'motivo', 'pendiente',
                                'auth_id', v_auth_id, 'plan', v_plan);
    END IF;
    IF COALESCE(v_pwd, '') = '' AND EXISTS (
         SELECT 1 FROM usuarios u
         WHERE u.auth_id = v_auth_id AND u.rol = 'miembro' AND u.status IS DISTINCT FROM 'revocado') THEN
      -- Verificó su correo pero nunca fijó contraseña: un enlace nuevo le deja terminar.
      RETURN jsonb_build_object('resultado', 'ok', 'accion', 'enlace', 'motivo', 'sin_contrasena',
                                'auth_id', v_auth_id, 'plan', v_plan);
    END IF;
    RETURN jsonb_build_object('resultado', 'ok', 'accion', 'ninguna', 'motivo', 'cuenta_existente');
  END IF;

  SELECT count(*) INTO v_n FROM usuarios
  WHERE tenant_id = v_tenant_id AND lower(trim(email)) = v_email;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('resultado', 'ok', 'accion', 'crear', 'motivo', 'nueva', 'plan', v_plan);
  END IF;
  IF v_n > 1 THEN
    RETURN jsonb_build_object('resultado', 'ok', 'accion', 'ninguna', 'motivo', 'ambiguo');
  END IF;

  SELECT * INTO v_perfil FROM usuarios
  WHERE tenant_id = v_tenant_id AND lower(trim(email)) = v_email;
  IF v_perfil.auth_id IS NOT NULL THEN
    RETURN jsonb_build_object('resultado', 'ok', 'accion', 'ninguna', 'motivo', 'vinculado');
  END IF;
  IF v_perfil.rol IS DISTINCT FROM 'miembro' THEN
    RETURN jsonb_build_object('resultado', 'ok', 'accion', 'ninguna', 'motivo', 'perfil_staff');
  END IF;
  v_hist := cuenta_historial_durable(v_perfil.id);
  IF v_hist <> '{}'::jsonb AND v_perfil.acceso_autorizado_at IS NULL THEN
    RETURN jsonb_build_object('resultado', 'ok', 'accion', 'ninguna', 'motivo', 'perfil_con_historial');
  END IF;
  -- Perfil vinculable por las reglas de 06A: se vincula SOLO al confirmar el correo.
  RETURN jsonb_build_object('resultado', 'ok', 'accion', 'crear', 'motivo', 'vincular', 'plan', v_plan);
END;
$$;

REVOKE ALL ON FUNCTION alta_publica_solicitar(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION alta_publica_solicitar(text, text, text, text) TO service_role;
