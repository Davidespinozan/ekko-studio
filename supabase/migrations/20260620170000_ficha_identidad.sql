-- ============================================================================
-- Ficha de identidad obligatoria + gate de ingreso (check-in)
-- ============================================================================
-- Decisión (David): rentar espacios con equipo caro exige saber QUIÉN entra y
-- responsabilizarlo. En la PRIMERA sesión recepción captura: foto, fecha de
-- nacimiento, domicilio e INE (foto), y el miembro FIRMA el contrato. El sistema
-- NO permite dar ingreso (check-in) hasta que la ficha esté completa.
--
-- Datos sensibles (domicilio, INE) → `usuarios_datos_privados` (RLS admin-only);
-- recepción los escribe vía la Netlify Function `reception-datos-identidad`
-- (service_role + audit). Los FLAGS de gate viven en `usuarios` (que recepción
-- ya lee) y solo los setea el backend.
-- ============================================================================

-- ── 1. Datos sensibles de identidad ─────────────────────────────────────────
ALTER TABLE usuarios_datos_privados
  ADD COLUMN IF NOT EXISTS fecha_nacimiento date,
  ADD COLUMN IF NOT EXISTS domicilio text,
  ADD COLUMN IF NOT EXISTS ine_folio text,          -- clave de elector / folio
  ADD COLUMN IF NOT EXISTS ine_foto_path text;      -- ruta en bucket privado 'identidad'

-- ── 2. Flags de gate en usuarios (recepción los lee; solo backend los setea) ─
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS identidad_completa boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contrato_firmado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contrato_firmado_at timestamptz;

COMMENT ON COLUMN usuarios.identidad_completa IS
  'true cuando recepción capturó foto+nacimiento+domicilio+INE. Gate de check-in.';
COMMENT ON COLUMN usuarios.contrato_firmado IS
  'true cuando el miembro firmó el contrato. Gate de check-in.';

-- ── 3. Bucket privado para fotos de INE ─────────────────────────────────────
-- public=false y SIN policies → solo service_role (las Netlify Functions) lo
-- toca; la lectura se hace con signed URLs generadas por el backend.
INSERT INTO storage.buckets (id, name, public)
VALUES ('identidad', 'identidad', false)
ON CONFLICT (id) DO NOTHING;

-- ── 4. Proteger los flags (C2): que el miembro no se los ponga solo ─────────
CREATE OR REPLACE FUNCTION proteger_columnas_privilegiadas_usuarios()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated' AND NOT is_admin() THEN
    IF NEW.rol                IS DISTINCT FROM OLD.rol
    OR NEW.tenant_id          IS DISTINCT FROM OLD.tenant_id
    OR NEW.status             IS DISTINCT FROM OLD.status
    OR NEW.membresia_tier     IS DISTINCT FROM OLD.membresia_tier
    OR NEW.no_shows_count     IS DISTINCT FROM OLD.no_shows_count
    OR NEW.bloqueado_hasta    IS DISTINCT FROM OLD.bloqueado_hasta
    OR NEW.identidad_completa IS DISTINCT FROM OLD.identidad_completa
    OR NEW.contrato_firmado   IS DISTINCT FROM OLD.contrato_firmado THEN
      RAISE EXCEPTION
        'EKKO_NO_AUTORIZADO: no podés modificar campos privilegiados de tu cuenta';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ── 5. Gate de check-in: no dar ingreso sin ficha completa + contrato ───────
-- BEFORE UPDATE sobre reservas: cubre check_in_atomic (QR) y check_in_manual_atomic
-- sin tocar esos RPCs. Se dispara al pasar la reserva a 'completada' (ingreso).
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
  IF NOT (OLD.status = 'confirmada' AND NEW.status = 'completada') THEN
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

DROP TRIGGER IF EXISTS trg_exigir_identidad_ingreso ON reservas;
CREATE TRIGGER trg_exigir_identidad_ingreso
  BEFORE UPDATE ON reservas
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION exigir_identidad_al_ingresar();
