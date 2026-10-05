-- ============================================================================
-- PKG-02C · FRONTERA DE AUTORIZACIÓN POR REST: avisos, notas y grants
-- ----------------------------------------------------------------------------
-- Causa raíz: las políticas y grants de 2026-05/06 protegían la FILA pero no la
-- intención sobre columnas, el estado de la cuenta ni la superficie expuesta.
-- Usuarios, reservas, membresías y datos privados ya se endurecieron (EKKO-039,
-- EKKO-124); avisos, notas y los GRANT por defecto quedaron con el modelo viejo.
--
--  1. Avisos (`notificaciones`): el cliente solo puede marcar leído/no leído lo
--     suyo; título, mensaje, metadata y las marcas de correo/push (evidencia de
--     00F) son del servidor. La política INSERT para "admin" (sin estado activo y
--     sin ningún consumidor en la app) se retira: los avisos los crean triggers,
--     crons y funciones con service_role.
--  2. Gate `cambiar_password` con autoridad del SERVIDOR: el aviso solo se cierra
--     cuando cambia la contraseña real en auth.users (trigger). El cliente no
--     puede apagarlo marcándolo leído: ni uno a uno ni con "marcar todas".
--  3. Notas de miembro: autor y rol se derivan de la sesión y de `usuarios`, no
--     del cliente, y son inmutables.
--  4. Grants: anon (y PUBLIC) no escribe en ninguna tabla ni vista y no ejecuta
--     ninguna función de aplicación; authenticated no escribe donde ninguna política lo
--     autoriza (defensa en profundidad: hoy lo frena RLS). TRUNCATE, que RLS no
--     cubre, se retira a ambos. El conjunto se DERIVA del esquema al aplicar.
--
-- Aditiva: sin UPDATE/DELETE de datos de negocio. No cambia el cuerpo de ninguna
-- función existente: las RPC cerradas solo cambian de grant para anon.
-- Preserva service_role, triggers y crons (current_user ≠ authenticated/anon).
-- Decisión: EKKO-136 (gate de contraseña en servidor). Tests:
-- src/__tests__/db/02c-frontera-rest.db.test.ts · supabase/tests/hardening_checks.sql §P5
-- ============================================================================

-- ── 1. Avisos: solo leído/no leído desde el cliente ──────────────────────────
DROP POLICY IF EXISTS "Notificaciones: admin del tenant crea" ON notificaciones;

DROP POLICY IF EXISTS "Notificaciones: usuario marca leída las propias" ON notificaciones;
CREATE POLICY "Notificaciones: usuario marca leída las propias" ON notificaciones
  FOR UPDATE TO authenticated
  USING (usuario_id = get_my_user_id())
  WITH CHECK (usuario_id = get_my_user_id());

-- SECURITY INVOKER a propósito (como proteger_columnas_privilegiadas_usuarios):
-- current_user debe ser el rol real de la sesión, no el dueño de la función.
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

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.usuario_id IS DISTINCT FROM OLD.usuario_id
     OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.titulo IS DISTINCT FROM OLD.titulo
     OR NEW.mensaje IS DISTINCT FROM OLD.mensaje
     OR NEW.metadata IS DISTINCT FROM OLD.metadata
     OR NEW.creada_at IS DISTINCT FROM OLD.creada_at
     OR NEW.push_enviado_at IS DISTINCT FROM OLD.push_enviado_at
     OR NEW.email_enviado_at IS DISTINCT FROM OLD.email_enviado_at
     OR NEW.email_resultado IS DISTINCT FROM OLD.email_resultado
     OR NEW.email_proveedor_id IS DISTINCT FROM OLD.email_proveedor_id THEN
    RAISE EXCEPTION 'EKKO_AVISO_SOLO_LECTURA: Un aviso solo se marca como leído; su contenido y su evidencia de envío son del servidor';
  END IF;

  -- El aviso de cambio de contraseña lo cierra el servidor cuando la contraseña
  -- cambia de verdad (on_auth_user_password_changed). Desde el cliente no se apaga:
  -- se conserva tal cual, sin error, para que "marcar todas" siga funcionando.
  IF OLD.tipo = 'cambiar_password' THEN
    NEW.leida := OLD.leida;
    NEW.leida_at := OLD.leida_at;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION notificaciones_frontera_cliente() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_notificaciones_frontera_cliente ON notificaciones;
CREATE TRIGGER trg_notificaciones_frontera_cliente
  BEFORE UPDATE ON notificaciones
  FOR EACH ROW EXECUTE FUNCTION notificaciones_frontera_cliente();

-- ── 2. Gate de contraseña: lo cierra el cambio REAL de contraseña ────────────
-- Mismo patrón que on_auth_user_email_changed. Si algo falla aquí, el cambio de
-- contraseña NO se revierte y el aviso queda abierto (el gate vuelve a salir):
-- nunca se produce un falso "contraseña cambiada".
CREATE OR REPLACE FUNCTION handle_auth_user_password_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password THEN
    BEGIN
      UPDATE notificaciones n
      SET leida = true, leida_at = now()
      FROM usuarios u
      WHERE u.auth_id = NEW.id AND n.usuario_id = u.id
        AND n.tipo = 'cambiar_password' AND NOT n.leida;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'handle_auth_user_password_change: no se pudo cerrar el aviso (%). El gate seguirá visible.', SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION handle_auth_user_password_change() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS on_auth_user_password_changed ON auth.users;
CREATE TRIGGER on_auth_user_password_changed
  AFTER UPDATE OF encrypted_password ON auth.users
  FOR EACH ROW
  WHEN (NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password)
  EXECUTE FUNCTION handle_auth_user_password_change();

-- ── 3. Notas de miembro: autor y rol del servidor, inmutables ────────────────
-- SECURITY INVOKER: current_user real; la lectura de `usuarios` pasa por RLS (la
-- propia fila siempre es legible) y service_role la salta.
CREATE OR REPLACE FUNCTION notas_miembro_autor_servidor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_rol text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.autor_id IS DISTINCT FROM OLD.autor_id OR NEW.autor_rol IS DISTINCT FROM OLD.autor_rol
       OR NEW.miembro_id IS DISTINCT FROM OLD.miembro_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.creada_at IS DISTINCT FROM OLD.creada_at THEN
      RAISE EXCEPTION 'EKKO_NOTA_AUTOR_INMUTABLE: El autor, el miembro y la fecha de una nota no cambian';
    END IF;
    RETURN NEW;
  END IF;

  -- INSERT desde una sesión: la identidad es la de la sesión, el rol el real.
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.autor_id := get_my_user_id();
  END IF;
  SELECT rol INTO v_rol FROM usuarios WHERE id = NEW.autor_id;
  IF v_rol IS NULL THEN
    RAISE EXCEPTION 'EKKO_NOTA_SIN_AUTOR: No se identificó al autor de la nota';
  END IF;
  NEW.autor_rol := v_rol;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION notas_miembro_autor_servidor() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_notas_miembro_autor_servidor ON notas_miembro;
CREATE TRIGGER trg_notas_miembro_autor_servidor
  BEFORE INSERT OR UPDATE ON notas_miembro
  FOR EACH ROW EXECUTE FUNCTION notas_miembro_autor_servidor();

-- ── 4. Grants: derivados del esquema al aplicar ──────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  -- 4a. anon: solo lectura en todo public (sus únicas políticas son SELECT).
  FOR r IN
    SELECT c.relname, c.relkind FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'p')
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM anon', r.relname);
  END LOOP;

  -- 4b. authenticated: sin escritura donde ninguna política la autoriza, y sin
  --     TRUNCATE/REFERENCES/TRIGGER en ningún lado (RLS no cubre TRUNCATE).
  FOR r IN
    SELECT c.relname FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON %I FROM authenticated', r.relname);
    IF NOT EXISTS (SELECT 1 FROM pg_policies p
                   WHERE p.schemaname = 'public' AND p.tablename = r.relname AND p.cmd <> 'SELECT') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I FROM authenticated', r.relname);
    END IF;
  END LOOP;
  -- Vistas: solo SELECT para authenticated.
  FOR r IN
    SELECT c.relname FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v'
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM authenticated', r.relname);
  END LOOP;

  -- 4c. anon no ejecuta ninguna función de APLICACIÓN (las de extensión no se
  --     tocan). En producción 29 de 30 también tenían EXECUTE para PUBLIC
  --     (`=X/postgres`, el default de Postgres), que es por donde anon lo hereda:
  --     se retira a ambos. authenticated y service_role conservan su grant
  --     EXPLÍCITO (default privileges de Supabase); los cuerpos no cambian. Los
  --     triggers no verifican EXECUTE al disparar (solo al crearse).
  FOR r IN
    SELECT p.oid::regprocedure AS firma FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                      WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.firma);
  END LOOP;
END;
$$;
