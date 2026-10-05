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

  for (const f of filas) {
    if (f.moneda !== MONEDA_PRINCIPAL) {
      if (f.estado_evidencia !== 'excluido') otras.add(f.moneda);
      continue;
    }
    const t = new Date(f.ocurrido_at).getTime();
    const enMes = t >= inicioMes.getTime();
    const enMesAnterior = !enMes && t >= inicioMesAnterior.getTime();
    const esReversal = f.clase === 'reembolso' || f.clase === 'disputa';

    if (f.clase === 'cobro' && f.estado_evidencia === 'firme') {
      if (enMes) {
        cobradoMes += f.monto_centavos;
        const c = conceptoDeOrigen(f.origen_negocio);
        const prev = porConcepto.get(c) ?? { centavos: 0, cobros: 0 };
        prev.centavos += f.monto_centavos;
        prev.cobros += 1;
        porConcepto.set(c, prev);
      } else if (enMesAnterior) {
        cobradoMesAnterior += f.monto_centavos;
      }
    }
    if (!enMes) continue;
    netoMes += f.efecto_neto_centavos;
    if (esReversal && f.estado_evidencia === 'firme') {
      reversadoMes += -f.efecto_neto_centavos;
      reversalesMes += 1;
    } else if (f.estado_evidencia === 'en_disputa') {
      enDisputaMes += f.monto_centavos;
    } else if (f.estado_evidencia === 'sin_resolver') {
      sinResolverCentavos += f.monto_centavos;
      sinResolverN += 1;
    }
  }

  const hace30d = ahora.getTime() - 30 * 24 * 60 * 60 * 1000;
  let fallidos30d = 0;
  let montoFallido = 0;
  for (const e of fallidos) {
    if (new Date(e.created_at).getTime() >= hace30d) {
      fallidos30d += 1;
      montoFallido += e.monto_centavos ?? 0;
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
    cobrosFallidos30d: fallidos30d,
    montoFallido30dCentavos: montoFallido,
    porConcepto: Array.from(porConcepto.entries())
      .map(([concepto, v]) => ({ concepto, ...v }))
      .sort((a, b) => b.centavos - a.centavos),
    otrasMonedas: Array.from(otras).sort()
  };
}
