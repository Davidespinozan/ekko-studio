-- ============================================================================
-- Planes por CRÉDITOS / CLASES / PAQUETES (además del mensual)
-- ============================================================================
-- Extiende `tiers` + `membresias` de forma ADITIVA (los planes mensuales
-- actuales quedan intactos: tipo='tiempo' por default). Patrón tomado de SALA.
--
-- Decisiones de negocio (David):
--   - Una sola membresía vigente por miembro (comprar reemplaza/renueva).
--   - No-show QUEMA el crédito (no se devuelve).
--   - Paquetes se SUMAN (comprar 10 + 10 = 20).
--
-- Tres tipos de plan:
--   tiempo   → acceso ilimitado mientras esté vigente (= el mensual de hoy).
--   creditos → N sesiones que NO vencen por fecha (se agotan por saldo).
--   hibrido  → N sesiones que vencen en `duracion_dias`.
-- El saldo vive en `membresias.creditos_restantes`; el historial en
-- `membresia_movimientos`. El descuento/devolución se hacen por TRIGGER sobre
-- `reservas` (cubre reserva del miembro Y de recepción sin tocar los RPCs
-- atómicos críticos).
-- ============================================================================

-- ── 1. Columnas de tipo de plan en tiers ────────────────────────────────────
ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'tiempo'
    CHECK (tipo IN ('tiempo', 'creditos', 'hibrido')),
  ADD COLUMN IF NOT EXISTS duracion_dias integer,      -- NULL = no vence por fecha
  ADD COLUMN IF NOT EXISTS clases_incluidas integer;   -- NULL = ilimitado; N = tamaño del paquete

COMMENT ON COLUMN tiers.tipo IS 'tiempo=ilimitado vigente · creditos=N sin vencer · hibrido=N con vencimiento';
COMMENT ON COLUMN tiers.clases_incluidas IS 'Sesiones del paquete (creditos/hibrido). NULL = ilimitado (tiempo).';
COMMENT ON COLUMN tiers.duracion_dias IS 'Vigencia en días (tiempo/hibrido). NULL = no vence (creditos).';

-- ── 2. Saldo de créditos en la membresía ────────────────────────────────────
ALTER TABLE membresias
  ADD COLUMN IF NOT EXISTS creditos_restantes integer;  -- NULL = ilimitado (tiempo)

COMMENT ON COLUMN membresias.creditos_restantes IS
  'Sesiones que le quedan al miembro (creditos/hibrido). NULL = ilimitado (tiempo).';

-- ── 3. Ledger append-only de movimientos de créditos ────────────────────────
CREATE TABLE IF NOT EXISTS membresia_movimientos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  membresia_id uuid NOT NULL REFERENCES membresias(id) ON DELETE CASCADE,
  usuario_id   uuid NOT NULL REFERENCES usuarios(id)  ON DELETE CASCADE,
  reserva_id   uuid REFERENCES reservas(id) ON DELETE SET NULL,
  tipo         text NOT NULL CHECK (tipo IN ('alta', 'debito', 'devolucion', 'ajuste', 'no_show')),
  delta        integer NOT NULL DEFAULT 0,
  saldo_after  integer,
  motivo       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mov_usuario_idx  ON membresia_movimientos (usuario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mov_reserva_idx  ON membresia_movimientos (reserva_id);

ALTER TABLE membresia_movimientos ENABLE ROW LEVEL SECURITY;

-- Lectura: el dueño ve los suyos; admin ve todo el tenant. Escritura: solo
-- service_role / SECURITY DEFINER (los triggers). Sin policies de INSERT/UPDATE/DELETE.
DROP POLICY IF EXISTS mov_read_self ON membresia_movimientos;
CREATE POLICY mov_read_self ON membresia_movimientos
  FOR SELECT TO authenticated
  USING (usuario_id IN (SELECT id FROM usuarios WHERE auth_id = auth.uid()));

DROP POLICY IF EXISTS mov_read_admin ON membresia_movimientos;
CREATE POLICY mov_read_admin ON membresia_movimientos
  FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id() AND is_admin());

-- ── 4. activar_membresia con lógica de créditos ─────────────────────────────
CREATE OR REPLACE FUNCTION activar_membresia(
  p_usuario_id uuid,
  p_tier_id uuid,
  p_stripe_subscription_id text DEFAULT NULL,
  p_stripe_customer_id text DEFAULT NULL,
  p_periodo_fin timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_usuario usuarios;
  v_tier tiers;
  v_now timestamptz := now();
  v_fin timestamptz;
  v_membresia_id uuid;
  v_es_paquete boolean;
  v_saldo_previo integer := 0;
  v_creditos integer;
BEGIN
  SELECT * INTO v_usuario FROM usuarios WHERE id = p_usuario_id;
  IF v_usuario.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_USUARIO_NO_EXISTE: Miembro no encontrado';
  END IF;

  SELECT * INTO v_tier
  FROM tiers
  WHERE id = p_tier_id AND tenant_id = v_usuario.tenant_id AND activo = true;
  IF v_tier.id IS NULL THEN
    RAISE EXCEPTION 'EKKO_TIER_INVALIDO: Plan no encontrado o inactivo';
  END IF;

  v_es_paquete := v_tier.tipo IN ('creditos', 'hibrido');

  -- Saldo previo para ACUMULAR (paquete sobre paquete).
  IF v_es_paquete THEN
    SELECT COALESCE(SUM(creditos_restantes), 0) INTO v_saldo_previo
    FROM membresias
    WHERE usuario_id = p_usuario_id
      AND status IN ('trialing', 'activa', 'past_due')
      AND creditos_restantes IS NOT NULL;
  END IF;

  -- Vigencia según tipo.
  IF v_tier.tipo = 'creditos' THEN
    v_fin := NULL;                                              -- no vence por fecha
  ELSIF v_tier.tipo = 'hibrido' THEN
    v_fin := v_now + (COALESCE(v_tier.duracion_dias, 30) || ' days')::interval;
  ELSE  -- tiempo
    v_fin := COALESCE(
      p_periodo_fin,
      CASE WHEN v_tier.duracion_dias IS NOT NULL
           THEN v_now + (v_tier.duracion_dias || ' days')::interval
           ELSE v_now + interval '1 month' END
    );
  END IF;

  -- Créditos de la nueva membresía (NULL = ilimitado).
  IF v_es_paquete THEN
    v_creditos := v_saldo_previo + COALESCE(v_tier.clases_incluidas, 0);
  ELSE
    v_creditos := NULL;
  END IF;

  -- Cerrar la membresía activa previa (una vigente por miembro).
  UPDATE membresias
  SET status = 'cancelada',
      cancelada_at = v_now,
      cancelada_efectiva_at = v_now,
      updated_at = v_now
  WHERE usuario_id = p_usuario_id
    AND status IN ('trialing', 'activa', 'past_due');

  -- Crear la membresía activa.
  INSERT INTO membresias (
    tenant_id, usuario_id, tier_id, status,
    periodo_actual_inicio, periodo_actual_fin, creditos_restantes,
    stripe_subscription_id, stripe_customer_id
  ) VALUES (
    v_usuario.tenant_id, p_usuario_id, p_tier_id, 'activa',
    v_now, v_fin, v_creditos,
    p_stripe_subscription_id, p_stripe_customer_id
  )
  RETURNING id INTO v_membresia_id;

  -- Ledger: alta.
  INSERT INTO membresia_movimientos (
    tenant_id, membresia_id, usuario_id, tipo, delta, saldo_after, motivo
  ) VALUES (
    v_usuario.tenant_id, v_membresia_id, p_usuario_id, 'alta',
    COALESCE(v_tier.clases_incluidas, 0), v_creditos,
    'Alta de ' || v_tier.slug
  );

  -- Reflejar en usuarios (la app gatea por status + membresia_tier).
  UPDATE usuarios
  SET status = 'activo',
      membresia_tier = v_tier.slug,
      membresia_activa_id = v_membresia_id
  WHERE id = p_usuario_id;

  RETURN jsonb_build_object(
    'success', true,
    'membresia_id', v_membresia_id,
    'tier', v_tier.slug,
    'periodo_fin', v_fin,
    'creditos', v_creditos
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION activar_membresia(uuid, uuid, text, text, timestamptz)
  FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION activar_membresia(uuid, uuid, text, text, timestamptz)
  TO service_role;

-- ── 5. Trigger: gate + débito de crédito al reservar ────────────────────────
-- BEFORE INSERT sobre reservas: cubre reserva del miembro Y de recepción sin
-- tocar los RPCs atómicos. FOR UPDATE serializa (evita gastar dos veces el
-- último crédito). Solo actúa si la membresía activa es de tipo paquete.
CREATE OR REPLACE FUNCTION creditos_debitar_al_reservar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem membresias;
  v_tipo text;
BEGIN
  IF NEW.status <> 'confirmada' THEN
    RETURN NEW;
  END IF;

  SELECT m.* INTO v_mem
  FROM membresias m
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_mem.id IS NULL THEN
    RETURN NEW;  -- sin membresía → el RPC ya gatea status='activo'
  END IF;

  SELECT tipo INTO v_tipo FROM tiers WHERE id = v_mem.tier_id;

  IF v_tipo IN ('creditos', 'hibrido') THEN
    IF v_mem.periodo_actual_fin IS NOT NULL AND v_mem.periodo_actual_fin <= now() THEN
      RAISE EXCEPTION 'EKKO_MEMBRESIA_VENCIDA: Tu paquete venció. Renová para seguir reservando.';
    END IF;
    IF COALESCE(v_mem.creditos_restantes, 0) < 1 THEN
      RAISE EXCEPTION 'EKKO_SIN_CREDITOS: No te quedan créditos. Comprá un paquete para reservar.';
    END IF;

    UPDATE membresias
    SET creditos_restantes = creditos_restantes - 1, updated_at = now()
    WHERE id = v_mem.id;

    INSERT INTO membresia_movimientos (
      tenant_id, membresia_id, usuario_id, reserva_id, tipo, delta, saldo_after, motivo
    ) VALUES (
      NEW.tenant_id, v_mem.id, NEW.usuario_id, NEW.id, 'debito', -1,
      v_mem.creditos_restantes - 1, 'Reserva ' || COALESCE(NEW.folio, '')
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_creditos_debitar ON reservas;
CREATE TRIGGER trg_creditos_debitar
  BEFORE INSERT ON reservas
  FOR EACH ROW
  EXECUTE FUNCTION creditos_debitar_al_reservar();

-- ── 6. Trigger: devolución al cancelar ──────────────────────────────────────
-- AFTER UPDATE sobre reservas: devuelve 1 crédito al dueño si (a) canceló el
-- estudio (cancelada_admin) o (b) el miembro canceló a tiempo. No-show NO
-- devuelve (queda el débito). Anti doble-devolución vía el ledger.
CREATE OR REPLACE FUNCTION creditos_devolver_al_cancelar()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mem membresias;
  v_min_horas integer;
  v_a_tiempo boolean;
BEGIN
  IF NOT (OLD.status = 'confirmada' AND NEW.status IN ('cancelada', 'cancelada_admin')) THEN
    RETURN NEW;
  END IF;

  -- ¿hubo débito para esta reserva y no se devolvió ya?
  IF NOT EXISTS (SELECT 1 FROM membresia_movimientos WHERE reserva_id = NEW.id AND tipo = 'debito') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM membresia_movimientos WHERE reserva_id = NEW.id AND tipo = 'devolucion') THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE((config->'reserva'->>'anticipacion_min_horas')::integer, 24)
    INTO v_min_horas FROM tenants WHERE id = NEW.tenant_id;
  v_a_tiempo := NEW.slot_inicio > now() + (v_min_horas || ' hours')::interval;

  -- El miembro que cancela tarde pierde el crédito; el estudio siempre devuelve.
  IF NEW.status <> 'cancelada_admin' AND NOT v_a_tiempo THEN
    RETURN NEW;
  END IF;

  SELECT m.* INTO v_mem
  FROM membresias m
  WHERE m.usuario_id = NEW.usuario_id
    AND m.status IN ('trialing', 'activa', 'past_due')
  ORDER BY m.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_mem.id IS NULL OR v_mem.creditos_restantes IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE membresias
  SET creditos_restantes = creditos_restantes + 1, updated_at = now()
  WHERE id = v_mem.id;

  INSERT INTO membresia_movimientos (
    tenant_id, membresia_id, usuario_id, reserva_id, tipo, delta, saldo_after, motivo
  ) VALUES (
    NEW.tenant_id, v_mem.id, NEW.usuario_id, NEW.id, 'devolucion', 1,
    v_mem.creditos_restantes + 1,
    CASE WHEN NEW.status = 'cancelada_admin'
         THEN 'Devolución (cancelado por el estudio)'
         ELSE 'Devolución (cancelación a tiempo)' END
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_creditos_devolver ON reservas;
CREATE TRIGGER trg_creditos_devolver
  AFTER UPDATE ON reservas
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION creditos_devolver_al_cancelar();
