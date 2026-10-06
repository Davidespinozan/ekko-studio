-- ============================================================================
-- PKG-06F · Agregados en el servidor (FR-62, FR-63; EKKO-148)
-- ============================================================================
-- PostgREST corta toda respuesta en 1000 filas (max_rows del proyecto). Un
-- total que el navegador suma sobre filas crudas queda MAL en silencio cuando
-- las filas pasan de 1000. Aquí, cada total/conteo de reportes que crece con el
-- tiempo se calcula en la base y viaja como UNA fila (o unos pocos grupos):
--
--  · reporte_creditos()                  pasivo de créditos (ledger completo)
--  · libro_economico_agregado(...)       el libro económico AGRUPADO por periodo,
--                                        clase, origen, moneda y estado (la lógica
--                                        de cada KPI sigue en el cliente, intacta)
--  · cobros_fallidos_resumen(p_desde)    cuántos y cuánto falló (payment_events)
--  · membresias_vivas_por_tier()         membresías facturables por plan y estado
--  · reservas_por_dia_estudio(...)       reservas por día DEL ESTUDIO
--                                        (America/Mazatlan, igual que el cliente)
--
-- Contrato común: el estudio sale de `get_my_tenant_id()` (el navegador no lo
-- manda); SECURITY INVOKER (la RLS de las filas de origen sigue mandando, nunca
-- se amplía el acceso); donde la fuente es de admin se exige admin y se FALLA
-- (no se devuelve un cero inventado); sumas de enteros → bigint; sin filas → 0.
-- No redefine ningún KPI (D-FIN-10): mismas filas, mismos filtros, misma fecha.
--
-- FR-65 (índice de membresia_movimientos por tenant): ya existe
-- `mov_tenant_fecha_idx (tenant_id, created_at DESC)` desde 20260921110000 y está
-- en producción. No se agrega otro.
--
-- Aditiva: solo funciones nuevas; el código viejo no las usa.
-- ============================================================================


-- ── Pasivo de créditos ───────────────────────────────────────────────────────
-- Misma semántica que `calcularCreditos` (src/admin/logic/reportesCreditos.ts):
--   vendidos = Σ max(0, delta) de 'alta'; usados = Σ |delta| de 'debito' y 'no_show';
--   saldo vivo = membresías trialing/activa/past_due con créditos > 0;
--   valor = Σ round(créditos × precio ÷ clases) por membresía (numeric, sin flotantes).
CREATE OR REPLACE FUNCTION reporte_creditos()
RETURNS TABLE (
  vendidos              bigint,
  usados                bigint,
  pasivo_sesiones       bigint,
  valor_pasivo_centavos bigint,
  miembros_con_saldo    integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
BEGIN
  IF v_tenant IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede leer los reportes';
  END IF;
  RETURN QUERY
  WITH mov AS (
    SELECT
      COALESCE(sum(GREATEST(0, m.delta)) FILTER (WHERE m.tipo = 'alta'), 0)::bigint AS vendidos,
      COALESCE(sum(abs(m.delta)) FILTER (WHERE m.tipo IN ('debito', 'no_show')), 0)::bigint AS usados
    FROM membresia_movimientos m
    WHERE m.tenant_id = v_tenant
  ), saldo AS (
    SELECT
      COALESCE(sum(ms.creditos_restantes), 0)::bigint AS pasivo,
      COALESCE(sum(
        CASE WHEN t.precio_centavos IS NOT NULL AND t.clases_incluidas IS NOT NULL AND t.clases_incluidas > 0
             THEN round(ms.creditos_restantes::numeric * t.precio_centavos / t.clases_incluidas)
             ELSE 0 END), 0)::bigint AS valor,
      count(*)::integer AS miembros
    FROM membresias ms
    LEFT JOIN tiers t ON t.id = ms.tier_id
    WHERE ms.tenant_id = v_tenant
      AND ms.status IN ('trialing', 'activa', 'past_due')
      AND ms.creditos_restantes IS NOT NULL
      AND ms.creditos_restantes > 0
  )
  SELECT mov.vendidos, mov.usados, saldo.pasivo, saldo.valor, saldo.miembros FROM mov, saldo;
END;
$$;
REVOKE ALL ON FUNCTION reporte_creditos() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reporte_creditos() TO authenticated;


-- ── Libro económico agrupado ─────────────────────────────────────────────────
-- Las MISMAS filas que `libro_economico(p_desde, p_hasta)` (que exige admin y fija
-- el estudio), agrupadas. `periodo` aplica los mismos cortes que el cliente:
-- 'mes' (≥ inicio del mes), 'mes_anterior' (≥ inicio del mes anterior), 'otro'.
CREATE OR REPLACE FUNCTION libro_economico_agregado(
  p_desde               timestamptz,
  p_inicio_mes_anterior timestamptz,
  p_inicio_mes          timestamptz,
  p_hasta               timestamptz
)
RETURNS TABLE (
  periodo              text,
  clase                text,
  origen_negocio       text,
  moneda               text,
  estado_evidencia     text,
  monto_centavos       bigint,
  efecto_neto_centavos bigint,
  n                    integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    CASE WHEN l.ocurrido_at >= p_inicio_mes THEN 'mes'
         WHEN l.ocurrido_at >= p_inicio_mes_anterior THEN 'mes_anterior'
         ELSE 'otro' END,
    l.clase, l.origen_negocio, l.moneda, l.estado_evidencia,
    COALESCE(sum(l.monto_centavos), 0)::bigint,
    COALESCE(sum(l.efecto_neto_centavos), 0)::bigint,
    count(*)::integer
  FROM libro_economico(p_desde, p_hasta) l
  GROUP BY 1, 2, 3, 4, 5
  ORDER BY 1, 2, 3, 4, 5;
$$;
REVOKE ALL ON FUNCTION libro_economico_agregado(timestamptz, timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION libro_economico_agregado(timestamptz, timestamptz, timestamptz, timestamptz) TO authenticated;


-- ── Cobros fallidos (diario de Stripe) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION cobros_fallidos_resumen(p_desde timestamptz)
RETURNS TABLE (cobros integer, monto_centavos bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
BEGIN
  IF v_tenant IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede leer los reportes';
  END IF;
  IF p_desde IS NULL THEN
    RAISE EXCEPTION 'EKKO_RANGO_INVALIDO: Falta la fecha de inicio';
  END IF;
  RETURN QUERY
  SELECT count(*)::integer, COALESCE(sum(COALESCE(pe.monto_centavos, 0)), 0)::bigint
  FROM payment_events pe
  WHERE pe.tenant_id = v_tenant AND pe.status = 'failed' AND pe.created_at >= p_desde;
END;
$$;
REVOKE ALL ON FUNCTION cobros_fallidos_resumen(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cobros_fallidos_resumen(timestamptz) TO authenticated;


-- ── Membresías facturables por plan ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION membresias_vivas_por_tier()
RETURNS TABLE (tier_id uuid, status text, n integer)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid := get_my_tenant_id();
BEGIN
  IF v_tenant IS NULL OR NOT is_admin() THEN
    RAISE EXCEPTION 'EKKO_NO_AUTORIZADO: Solo un admin puede leer los reportes';
  END IF;
  RETURN QUERY
  SELECT ms.tier_id, ms.status, count(*)::integer
  FROM membresias ms
  WHERE ms.tenant_id = v_tenant AND ms.status IN ('activa', 'trialing', 'past_due')
  GROUP BY ms.tier_id, ms.status
  ORDER BY ms.tier_id, ms.status;
END;
$$;
REVOKE ALL ON FUNCTION membresias_vivas_por_tier() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION membresias_vivas_por_tier() TO authenticated;


-- ── Reservas por día del estudio ─────────────────────────────────────────────
-- Mismo criterio que la gráfica del dashboard: reservas no canceladas con
-- slot_inicio en [p_desde, p_hasta), por día en America/Mazatlan (la zona del
-- estudio, `ZONA_ESTUDIO` del cliente). La RLS de `reservas` decide qué se ve.
CREATE OR REPLACE FUNCTION reservas_por_dia_estudio(p_desde timestamptz, p_hasta timestamptz)
RETURNS TABLE (dia date, n integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT (r.slot_inicio AT TIME ZONE 'America/Mazatlan')::date, count(*)::integer
  FROM reservas r
  WHERE r.tenant_id = get_my_tenant_id()
    AND r.status NOT IN ('cancelada', 'cancelada_admin')
    AND r.slot_inicio >= p_desde AND r.slot_inicio < p_hasta
  GROUP BY 1
  ORDER BY 1;
$$;
REVOKE ALL ON FUNCTION reservas_por_dia_estudio(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reservas_por_dia_estudio(timestamptz, timestamptz) TO authenticated;
