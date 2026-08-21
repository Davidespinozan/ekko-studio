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

export interface CobradoResult {
  cobradoMesCentavos: number;
  cobradoMesAnteriorCentavos: number;
  cobradoMesPorcentaje: number | null; // vs mes anterior; null si no hay base
  reembolsadoMesCentavos: number;
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
  ahora: Date = new Date()
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
    } else if (e.status === 'refunded') {
      if (t >= inicioMes.getTime()) reembolsadoMes += monto;
    } else if (e.status === 'failed') {
      if (t >= hace30d) {
        fallidos30d += 1;
        montoFallido += monto;
      }
    }
  }

  const cobradoMesPorcentaje =
    cobradoMesAnterior > 0 ? Math.round(((cobradoMes - cobradoMesAnterior) / cobradoMesAnterior) * 100) : null;

  return {
    cobradoMesCentavos: cobradoMes,
    cobradoMesAnteriorCentavos: cobradoMesAnterior,
    cobradoMesPorcentaje,
    reembolsadoMesCentavos: reembolsadoMes,
    cobrosFallidos30d: fallidos30d,
    montoFallido30dCentavos: montoFallido,
    porConcepto: Array.from(porConcepto.entries())
      .map(([concepto, v]) => ({ concepto, ...v }))
      .sort((a, b) => b.centavos - a.centavos)
  };
}
