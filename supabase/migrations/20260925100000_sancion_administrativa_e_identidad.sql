-- ============================================================================
-- Fase 1 de la auditoría de identidad única (2026-09-25):
--   1. Sanción administrativa separada del estado comercial de la membresía.
--   2. Una operación de membresía (activar, reanudar, sync de Stripe) NUNCA
--      levanta una sanción ni una revocación (trigger, vale para todo escritor).
--   3. Campos que sostienen la identidad verificada (avatar_url,
--      contrato_firmado_at) y la sanción: fuera del alcance del propio miembro.
--   4. `identidad_completa` coherente por trigger, sin importar la ruta.
--   5. Alta en Auth: una fila `usuarios` sin auth_id y con el mismo correo
--      normalizado se VINCULA; si hay ambigüedad, el alta falla en voz alta.
-- ============================================================================

-- ── 1. Sanción administrativa ──────────────────────────────────────────────
-- MEMBRESÍA dice si tiene plan/créditos/vigencia (tabla `membresias`).
-- SANCIÓN dice si el estudio le permite usar el servicio. Hasta hoy ambas se
-- expresaban con `status='suspendido'` (igual que la pausa voluntaria), y un
-- cobro, una reanudación o una activación en mostrador podían "reactivar" a
-- quien el admin había suspendido.
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS sancionado_at timestamptz,
  ADD COLUMN IF NOT EXISTS sancion_motivo text;

COMMENT ON COLUMN usuarios.sancionado_at IS
  'Sanción administrativa vigente (NULL = ninguna). Mientras exista, status se fuerza a suspendido: ninguna membresía la levanta. Solo staff la pone o la quita (con motivo, auditado).';
COMMENT ON COLUMN usuarios.sancion_motivo IS 'Motivo de la sanción vigente.';

-- Backfill derivable: un MIEMBRO suspendido cuya membresía NO está pausada lo
-- suspendió el estudio (la pausa deja `membresias.status = pausada`). Sin esto,
-- la primera activación posterior a esta migración les devolvería el acceso.
UPDATE usuarios u
SET sancionado_at  = COALESCE(u.updated_at, now()),
    sancion_motivo = 'Cuenta suspendida antes de separar sanción y membresía (migración 20260925100000)'
WHERE u.rol = 'miembro'
  AND u.status = 'suspendido'
  AND u.sancionado_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM membresias m WHERE m.usuario_id = u.id AND m.status = 'pausada'
  );

-- ── 2. La sanción manda sobre cualquier escritor ───────────────────────────
-- BEFORE UPDATE: si hay sanción, la cuenta queda `suspendido` la escriba quien
-- la escriba (activar_membresia, staff_pausar_membresia al reanudar,
-- sync_membresia_stripe, cambiar-plan…). Levantarla = poner sancionado_at en
-- NULL y el status deseado en el MISMO UPDATE (reception-update-member).
-- Y una operación de membresía (la que cambia membresia_activa_id) no saca a
-- nadie de `revocado`.
CREATE OR REPLACE FUNCTION usuarios_sancion_manda()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.sancionado_at IS NOT NULL AND NEW.status NOT IN ('suspendido', 'revocado') THEN
    NEW.status := 'suspendido';
  END IF;

  IF OLD.status = 'revocado' AND NEW.status = 'activo'
     AND NEW.membresia_activa_id IS DISTINCT FROM OLD.membresia_activa_id THEN
    NEW.status := 'revocado';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sancion_manda ON usuarios;
CREATE TRIGGER trg_sancion_manda
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION usuarios_sancion_manda();

-- ── 3. Columnas privilegiadas: identidad y sanción ─────────────────────────
-- Recrea `proteger_columnas_privilegiadas_usuarios` desde su ÚLTIMA definición
-- (20260921100000) sumando: avatar_url (es la FOTO que cuenta para
-- identidad_completa: un miembro verificado podía cambiársela por PostgREST),
-- contrato_firmado_at (evento histórico), sancionado_at y sancion_motivo.
-- El miembro sigue editando nombre y teléfono desde su perfil.
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

  RETURN NEW;
END;
$$;

-- ── 4. identidad_completa coherente por construcción ───────────────────────
-- Regla (20260620170000): foto (avatar_url) + fecha de nacimiento + domicilio +
-- foto de INE. La calculaba solo la Netlify Function; la foto subida desde la
-- ficha de admin (PostgREST) no la recalculaba.
CREATE OR REPLACE FUNCTION calcular_identidad_completa(p_avatar_url text, p_usuario_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p_avatar_url, '') <> ''
     AND EXISTS (
       SELECT 1 FROM usuarios_datos_privados d
       WHERE d.usuario_id = p_usuario_id
         AND d.fecha_nacimiento IS NOT NULL
         AND COALESCE(d.domicilio, '') <> ''
         AND COALESCE(d.ine_foto_path, '') <> ''
     );
$$;
REVOKE ALL ON FUNCTION calcular_identidad_completa(text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION usuarios_identidad_por_avatar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.avatar_url IS DISTINCT FROM OLD.avatar_url THEN
    NEW.identidad_completa := calcular_identidad_completa(NEW.avatar_url, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_identidad_por_avatar ON usuarios;
CREATE TRIGGER trg_identidad_por_avatar
  BEFORE UPDATE OF avatar_url ON usuarios
  FOR EACH ROW EXECUTE FUNCTION usuarios_identidad_por_avatar();

CREATE OR REPLACE FUNCTION datos_privados_recalcular_identidad()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE usuarios u
  SET identidad_completa = calcular_identidad_completa(u.avatar_url, u.id)
  WHERE u.id = NEW.usuario_id
    AND u.identidad_completa IS DISTINCT FROM calcular_identidad_completa(u.avatar_url, u.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_dp_recalcular_identidad ON usuarios_datos_privados;
CREATE TRIGGER trg_dp_recalcular_identidad
  AFTER INSERT OR UPDATE OF fecha_nacimiento, domicilio, ine_foto_path ON usuarios_datos_privados
  FOR EACH ROW EXECUTE FUNCTION datos_privados_recalcular_identidad();

-- ── 5. Alta en Auth: vincular, no ignorar ──────────────────────────────────
-- Antes: `ON CONFLICT (tenant_id, email) DO NOTHING` → si ya existía la fila
-- (p. ej. creada por un admin sin cuenta de acceso) la cuenta de Auth quedaba
-- sin perfil y nadie se enteraba. Ahora, con el correo normalizado
-- (lower/trim):
--   · 0 filas         → INSERT (como siempre).
--   · 1 fila, sin auth_id, mismo tenant → LINK (auth_id) + audit `auth_vinculado`.
--   · 1 fila YA vinculada a otra cuenta, o >1 filas → EXCEPCIÓN: el alta en
--     Auth se revierte. Nunca se roba el auth_id de otra fila.
--   · correo NULL/vacío/sin @ → EXCEPCIÓN EKKO_EMAIL_INVALIDO.
--   · La búsqueda es por tenant: el mismo correo en otro estudio no se vincula.
--   · Concurrencia: dos altas simultáneas con el mismo correo las frena Auth
--     (correo único en auth.users); dos filas `usuarios` con el mismo correo
--     normalizado las frena el índice usuarios_tenant_email_lower_uniq.
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

  UPDATE usuarios
  SET auth_id  = NEW.id,
      email    = v_email,
      nombre   = COALESCE(nombre, v_nombre),
      telefono = COALESCE(telefono, v_telefono)
  WHERE id = v_existente.id;

  INSERT INTO audit_log (tenant_id, actor_usuario_id, actor_rol, accion, target_tipo, target_id, metadata)
  VALUES (v_tenant_id, NULL, 'sistema', 'auth_vinculado', 'usuario', v_existente.id,
          jsonb_build_object('auth_id', NEW.id, 'email', v_email));

  RETURN NEW;
END;
$$;
