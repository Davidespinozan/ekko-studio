// ============================================================================
// Cálculo PURO de los KPIs de negocio recurrente (Economía) del admin.
// Sin Supabase ni React: recibe filas ya leídas y devuelve los KPIs. Así se
// testea la lógica financiera (MRR, ARR, ARPU, churn, LTV) de forma aislada.
//
// Convención: TODO en centavos (enteros). Los tiers anuales se mensualizan
// (precio ÷ 12) para que el MRR sea comparable entre planes.
// ============================================================================

export interface TierLite {
  id: string;
  slug: string;
  nombre: string;
  precio_centavos: number;
  periodo: 'mensual' | 'anual';
  moneda: string;
  /** 'tiempo' = recurrente (default). 'creditos'/'hibrido' = paquete de pago único. */
  tipo?: 'tiempo' | 'creditos' | 'hibrido' | null;
}

export interface MembresiaLite {
  tier_id: string;
  status: string;
  /** PKG-06F: cuántas membresías representa la fila (grupo del servidor). Default 1. */
  n?: number;
}

export interface IngresoPorPlan {
  slug: string;
  nombre: string;
  mrrCentavos: number;
  miembros: number;
}

export interface EconomiaResult {
  mrrCentavos: number;
  arrCentavos: number;
  arpuCentavos: number;
  activosConPlan: number;
  churnMensualPct: number | null; // null si no hay activos para calcular
  vidaMediaMeses: number | null; // null si churn = 0 (indeterminado)
  ltvCentavos: number | null;
  moneda: string;
  ingresoPorPlan: IngresoPorPlan[];
  /** Paquetes de créditos vigentes: son ingreso de UNA vez, NO entran al MRR. */
  paquetesActivos: number;
}

// Estados que SÍ generan ingreso recurrente hoy. past_due sigue contando: el
// acceso sigue vivo y Stripe reintenta el cobro (no es una baja todavía).
export const STATUS_FACTURABLE = new Set(['activa', 'trialing', 'past_due']);

/**
 * Solo los planes por tiempo son ingreso RECURRENTE. Un paquete de créditos
 * (creditos/hibrido) se cobra una sola vez: sumarlo al MRR inflaba MRR, ARR,
 * ARPU y LTV con cada paquete vigente. (Lección de SALA, 4ef2d4b.)
 */
export function esRecurrente(t: Pick<TierLite, 'tipo'>): boolean {
  return (t.tipo ?? 'tiempo') === 'tiempo';
}

/** Precio mensualizado de un tier (los anuales se dividen entre 12). */
export function mensualizar(t: Pick<TierLite, 'precio_centavos' | 'periodo'>): number {
  return t.periodo === 'anual' ? Math.round(t.precio_centavos / 12) : t.precio_centavos;
}

/**
 * @param tiers            catálogo de planes del tenant
 * @param membresiasActivas membresías con status facturable (activa/trialing/past_due)
 * @param bajas90d         nº de membresías canceladas en los últimos 90 días
 */
export function calcularEconomia(
  tiers: TierLite[],
  membresiasActivas: MembresiaLite[],
  bajas90d: number
): EconomiaResult {
  const tierPorId = new Map(tiers.map((t) => [t.id, t]));

  // MRR + desglose por plan. Solo cuentan las membresías cuyo tier existe.
  const acumPorTier = new Map<string, { tier: TierLite; mrr: number; miembros: number }>();
  let mrrCentavos = 0;
  let activosConPlan = 0;
  let paquetesActivos = 0;

  for (const m of membresiasActivas) {
    if (!STATUS_FACTURABLE.has(m.status)) continue;
    const tier = tierPorId.get(m.tier_id);
    if (!tier) continue;
    const k = m.n ?? 1;
    if (!esRecurrente(tier)) {
      paquetesActivos += k;
      continue;
    }
    const mensual = mensualizar(tier);
    mrrCentavos += mensual * k;
    activosConPlan += k;
    const prev = acumPorTier.get(tier.id) ?? { tier, mrr: 0, miembros: 0 };
    prev.mrr += mensual * k;
    prev.miembros += k;
    acumPorTier.set(tier.id, prev);
  }

  const ingresoPorPlan: IngresoPorPlan[] = Array.from(acumPorTier.values())
    .map((x) => ({ slug: x.tier.slug, nombre: x.tier.nombre, mrrCentavos: x.mrr, miembros: x.miembros }))
    .sort((a, b) => b.mrrCentavos - a.mrrCentavos);

  // Moneda dominante = la del plan que más MRR aporta (default MXN).
  const moneda = ingresoPorPlan.length
    ? (tierPorId.get(
        acumPorTier.size
          ? Array.from(acumPorTier.values()).sort((a, b) => b.mrr - a.mrr)[0].tier.id
          : ''
      )?.moneda ?? 'MXN')
    : 'MXN';

  const arrCentavos = mrrCentavos * 12;
  const arpuCentavos = activosConPlan > 0 ? Math.round(mrrCentavos / activosConPlan) : 0;

  // Churn mensual estimado: bajas de 90d repartidas en 3 meses sobre la base
  // activa. Necesita una base > 0 para tener sentido.
  let churnMensualPct: number | null = null;
  let vidaMediaMeses: number | null = null;
  let ltvCentavos: number | null = null;

  if (activosConPlan > 0) {
    churnMensualPct = (bajas90d / 3 / activosConPlan) * 100;
    if (churnMensualPct > 0) {
      // Vida media = 1 / churn (en meses). Se topa a 36m para no inflar el LTV
      // cuando el churn es minúsculo (muestra chica).
      vidaMediaMeses = Math.min(36, 100 / churnMensualPct);
      ltvCentavos = Math.round(arpuCentavos * vidaMediaMeses);
    }
  }

  return {
    mrrCentavos,
    arrCentavos,
    arpuCentavos,
    activosConPlan,
    churnMensualPct,
    vidaMediaMeses,
    ltvCentavos,
    moneda,
    ingresoPorPlan,
    paquetesActivos
  };
}
