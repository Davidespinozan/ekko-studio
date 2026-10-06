// ============================================================================
// Cálculo PURO de lo COBRADO de verdad, para contrastar con el MRR (que es
// ingreso contratado, no cobro real). Todo en centavos.
//
// R2-B (PKG-01N): la fuente es el LIBRO ECONÓMICO (`v_libro_economico`, leído
// por la RPC `libro_economico`), que compone payment_events + ventas_mostrador +
// reversales_pago y ya trae cada fila clasificada:
//   · bruto  = cobros FIRMES (Stripe y mostrador), una vez cada uno;
//   · neto   = Σ efecto_neto_centavos (bruto − reembolsos/disputas firmes con
//     origen resuelto);
//   · lo no atribuible (`sin_resolver`) se muestra aparte y NO entra al neto.
// Antes se sumaba payment_events crudo: sin mostrador, sin restar reversales y
// con la fecha de inserción en vez de la del proveedor.
// ============================================================================

/** Fila de `v_libro_economico` (solo lo que usa el reporte). */
export interface LibroFila {
  clase: string; // cobro | cortesia | reembolso | disputa
  origen_negocio: string;
  canal: string;
  moneda: string;
  monto_centavos: number;
  efecto_neto_centavos: number;
  estado_evidencia: string; // firme | pendiente | en_disputa | anulado | sin_resolver | excluido
  ocurrido_at: string;
}

/** Cobro fallido del diario de Stripe (no es ingreso; da ojos a la cobranza). */
export interface PagoFallido {
  created_at: string;
  monto_centavos: number | null;
}

export interface CobradoResult {
  /** Bruto firme del mes (Stripe + mostrador). */
  cobradoMesCentavos: number;
  cobradoMesAnteriorCentavos: number;
  cobradoMesPorcentaje: number | null; // vs mes anterior; null si no hay base
  /** Reembolsos y disputas perdidas del mes, con origen resuelto (restan del neto). */
  reversadoMesCentavos: number;
  reversalesMes: number;
  /** Bruto − reversado del mes. */
  netoMesCentavos: number;
  /** Disputas abiertas del mes: todavía no restan. */
  enDisputaMesCentavos: number;
  /** Cobros o reversales del mes que no se pudieron atribuir: fuera del neto. */
  sinResolverMesCentavos: number;
  sinResolverMes: number;
  cobrosFallidos30d: number;
  montoFallido30dCentavos: number;
  porConcepto: { concepto: string; centavos: number; cobros: number }[];
  /** Monedas distintas a la principal presentes en el rango (no se mezclan). */
  otrasMonedas: string[];
}

export const MONEDA_PRINCIPAL = 'mxn';

export function conceptoDeOrigen(origen: string): string {
  switch (origen) {
    case 'suscripcion_alta':
    case 'suscripcion_renovacion':
    case 'suscripcion':
      return 'Mensualidades';
    case 'cambio_de_plan':
      return 'Cambios de plan';
    case 'paquete':
      return 'Paquetes';
    case 'invitados_extra':
      return 'Invitados extra';
    case 'venta_mostrador':
      return 'Mostrador';
    default:
      return 'Otros';
  }
}

/**
 * PKG-06F: un GRUPO del libro económico (lo que devuelve la RPC
 * `libro_economico_agregado`): mismas columnas que deciden cada KPI, con la suma
 * de montos y cuántas filas representa. `periodo` usa los mismos cortes que
 * `calcularCobrado` (inicio del mes y del mes anterior, en la zona del estudio).
 */
export interface LibroGrupo {
  periodo: 'mes' | 'mes_anterior' | 'otro';
  clase: string;
  origen_negocio: string;
  moneda: string;
  estado_evidencia: string;
  monto_centavos: number;
  efecto_neto_centavos: number;
  n: number;
}

/** Cobros fallidos ya contados en la base (`cobros_fallidos_resumen`). */
export interface FallidosResumen {
  cobros: number;
  monto_centavos: number;
}

/** Agrupa filas como lo hace la base (para el camino por filas y para las pruebas de equivalencia). */
export function agruparLibro(filas: LibroFila[], inicioMes: Date, inicioMesAnterior: Date): LibroGrupo[] {
  const grupos = new Map<string, LibroGrupo>();
  for (const f of filas) {
    const t = new Date(f.ocurrido_at).getTime();
    const periodo: LibroGrupo['periodo'] = t >= inicioMes.getTime() ? 'mes' : t >= inicioMesAnterior.getTime() ? 'mes_anterior' : 'otro';
    const clave = [periodo, f.clase, f.origen_negocio, f.moneda, f.estado_evidencia].join('|');
    const g = grupos.get(clave) ?? { periodo, clase: f.clase, origen_negocio: f.origen_negocio, moneda: f.moneda, estado_evidencia: f.estado_evidencia, monto_centavos: 0, efecto_neto_centavos: 0, n: 0 };
    g.monto_centavos += f.monto_centavos;
    g.efecto_neto_centavos += f.efecto_neto_centavos;
    g.n += 1;
    grupos.set(clave, g);
  }
  return [...grupos.values()];
}

/**
 * Lo cobrado a partir de los GRUPOS del libro (PKG-06F). Misma semántica que el
 * cálculo por filas: cada suma es aditiva y cada conteo suma `n`.
 */
export function calcularCobradoAgregado(grupos: LibroGrupo[], fallidos: FallidosResumen = { cobros: 0, monto_centavos: 0 }): CobradoResult {
  let cobradoMes = 0;
  let cobradoMesAnterior = 0;
  let reversadoMes = 0;
  let reversalesMes = 0;
  let netoMes = 0;
  let enDisputaMes = 0;
  let sinResolverCentavos = 0;
  let sinResolverN = 0;
  const porConcepto = new Map<string, { centavos: number; cobros: number }>();
  const otras = new Set<string>();

  for (const g of grupos) {
    const monto = Number(g.monto_centavos);
    const neto = Number(g.efecto_neto_centavos);
    const n = Number(g.n);
    if (g.moneda !== MONEDA_PRINCIPAL) {
      if (g.estado_evidencia !== 'excluido') otras.add(g.moneda);
      continue;
    }
    const enMes = g.periodo === 'mes';
    const esReversal = g.clase === 'reembolso' || g.clase === 'disputa';
    if (g.clase === 'cobro' && g.estado_evidencia === 'firme') {
      if (enMes) {
        cobradoMes += monto;
        const c = conceptoDeOrigen(g.origen_negocio);
        const prev = porConcepto.get(c) ?? { centavos: 0, cobros: 0 };
        prev.centavos += monto;
        prev.cobros += n;
        porConcepto.set(c, prev);
      } else if (g.periodo === 'mes_anterior') {
        cobradoMesAnterior += monto;
      }
    }
    if (!enMes) continue;
    netoMes += neto;
    if (esReversal && g.estado_evidencia === 'firme') {
      reversadoMes += -neto;
      reversalesMes += n;
    } else if (g.estado_evidencia === 'en_disputa') {
      enDisputaMes += monto;
    } else if (g.estado_evidencia === 'sin_resolver') {
      sinResolverCentavos += monto;
      sinResolverN += n;
    }
  }

  const cobradoMesPorcentaje =
    cobradoMesAnterior > 0 ? Math.round(((cobradoMes - cobradoMesAnterior) / cobradoMesAnterior) * 100) : null;

  return {
    cobradoMesCentavos: cobradoMes,
    cobradoMesAnteriorCentavos: cobradoMesAnterior,
    cobradoMesPorcentaje,
    reversadoMesCentavos: reversadoMes,
    reversalesMes,
    netoMesCentavos: netoMes,
    enDisputaMesCentavos: enDisputaMes,
    sinResolverMesCentavos: sinResolverCentavos,
    sinResolverMes: sinResolverN,
    cobrosFallidos30d: Number(fallidos.cobros),
    montoFallido30dCentavos: Number(fallidos.monto_centavos),
    porConcepto: Array.from(porConcepto.entries())
      .map(([concepto, v]) => ({ concepto, ...v }))
      .sort((a, b) => b.centavos - a.centavos),
    otrasMonedas: Array.from(otras).sort()
  };
}

/**
 * @param filas     filas del libro económico del tenant (al menos desde el inicio del mes anterior)
 * @param inicioMes inicio del mes actual (instante, en la zona del estudio)
 * @param inicioMesAnterior inicio del mes anterior
 * @param ahora     instante actual
 * @param fallidos  cobros fallidos del diario (últimos ~31 días)
 */
export function calcularCobrado(
  filas: LibroFila[],
  inicioMes: Date,
  inicioMesAnterior: Date,
  ahora: Date = new Date(),
  fallidos: PagoFallido[] = []
): CobradoResult {
  const hace30d = ahora.getTime() - 30 * 24 * 60 * 60 * 1000;
  let cobros = 0;
  let monto = 0;
  for (const e of fallidos) {
    if (new Date(e.created_at).getTime() >= hace30d) {
      cobros += 1;
      monto += e.monto_centavos ?? 0;
    }
  }
  return calcularCobradoAgregado(agruparLibro(filas, inicioMes, inicioMesAnterior), { cobros, monto_centavos: monto });
}
