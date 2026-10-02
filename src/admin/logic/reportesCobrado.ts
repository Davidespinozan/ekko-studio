// ============================================================================
// Cálculo PURO de lo COBRADO de verdad (payment_events de Stripe), para
// contrastar con el MRR (que es ingreso contratado, no cobro real).
// Todo en centavos. (SALA 616ede2 / useReportesCobrado.)
// ============================================================================

export interface PagoEvento {
  created_at: string;
  monto_centavos: number | null;
  status: string | null; // 'succeeded' | 'failed' | 'refunded'
  stripe_event_type: string;
}

/** PKG-01G: un Refund de Stripe (re_…), monto EXACTO. Nunca charge.amount_refunded. */
export interface ReembolsoEvento {
  stripe_object_id: string;
  monto_centavos: number;
  estado_proveedor: string; // solo 'succeeded' cuenta
  fecha: string; // stripe_created_at ?? created_at
}

export interface CobradoResult {
  cobradoMesCentavos: number;
  cobradoMesAnteriorCentavos: number;
  cobradoMesPorcentaje: number | null; // vs mes anterior; null si no hay base
  reembolsadoMesCentavos: number;
  reembolsosMes: number;
  cobrosFallidos30d: number;
  montoFallido30dCentavos: number;
  porConcepto: { concepto: string; centavos: number; cobros: number }[];
}

function concepto(tipo: string): string {
  if (tipo === 'invoice.paid') return 'Mensualidades';
  if (tipo === 'payment_intent.succeeded') return 'Paquetes e invitados';
  return tipo;
}

/**
 * @param eventos   payment_events del tenant (al menos desde el inicio del mes anterior)
 * @param inicioMes inicio del mes actual (instante, en la zona del estudio)
 * @param inicioMesAnterior inicio del mes anterior
 * @param ahora     instante actual
 */
export function calcularCobrado(
  eventos: PagoEvento[],
  inicioMes: Date,
  inicioMesAnterior: Date,
  ahora: Date = new Date(),
  reembolsos: ReembolsoEvento[] = []
): CobradoResult {
  const hace30d = ahora.getTime() - 30 * 24 * 60 * 60 * 1000;
  let cobradoMes = 0;
  let cobradoMesAnterior = 0;
  let reembolsadoMes = 0;
  let fallidos30d = 0;
  let montoFallido = 0;
  const porConcepto = new Map<string, { centavos: number; cobros: number }>();

  for (const e of eventos) {
    const t = new Date(e.created_at).getTime();
    const monto = e.monto_centavos ?? 0;
    if (e.status === 'succeeded') {
      if (t >= inicioMes.getTime()) {
        cobradoMes += monto;
        const c = concepto(e.stripe_event_type);
        const prev = porConcepto.get(c) ?? { centavos: 0, cobros: 0 };
        prev.centavos += monto;
        prev.cobros += 1;
        porConcepto.set(c, prev);
      } else if (t >= inicioMesAnterior.getTime()) {
        cobradoMesAnterior += monto;
      }
    } else if (e.status === 'failed') {
      if (t >= hace30d) {
        fallidos30d += 1;
        montoFallido += monto;
      }
    }
  }

  // PKG-01G: cada objeto Refund cuenta UNA vez (identidad re_…). Antes se sumaban
  // las filas `refunded` de charge.refunded, que traen el ACUMULADO: dos parciales
  // de 100 y 50 reportaban 250 en vez de 150.
  const vistos = new Set<string>();
  let reembolsosMes = 0;
  for (const r of reembolsos) {
    if (r.estado_proveedor !== 'succeeded' || vistos.has(r.stripe_object_id)) continue;
    vistos.add(r.stripe_object_id);
    if (new Date(r.fecha).getTime() >= inicioMes.getTime()) {
      reembolsadoMes += r.monto_centavos;
      reembolsosMes += 1;
    }
  }

  const cobradoMesPorcentaje =
    cobradoMesAnterior > 0 ? Math.round(((cobradoMes - cobradoMesAnterior) / cobradoMesAnterior) * 100) : null;

  return {
    cobradoMesCentavos: cobradoMes,
    cobradoMesAnteriorCentavos: cobradoMesAnterior,
    cobradoMesPorcentaje,
    reembolsadoMesCentavos: reembolsadoMes,
    reembolsosMes,
    cobrosFallidos30d: fallidos30d,
    montoFallido30dCentavos: montoFallido,
    porConcepto: Array.from(porConcepto.entries())
      .map(([concepto, v]) => ({ concepto, ...v }))
      .sort((a, b) => b.centavos - a.centavos)
  };
}
