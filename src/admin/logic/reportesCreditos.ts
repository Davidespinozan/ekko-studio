// ============================================================================
// reportesCreditos — "pasivo de créditos" del estudio (modelo de paquetes).
//
// En el modelo de créditos cobras por adelantado: cada crédito que un miembro
// pagó pero aún no usó es CAJA que recibiste "debiendo" una sesión (deferred
// revenue). Si ese pasivo crece y no se consume, es señal de que la gente
// compra y no viene → riesgo de baja.
//
// Pura para testearla sin datos ni UI.
// ============================================================================

/** Un movimiento del ledger de créditos (membresia_movimientos). */
export interface MovimientoLite {
  tipo: string; // 'alta' | 'debito' | 'devolucion' | 'ajuste' | 'no_show'
  delta: number; // + al vender/devolver, − al consumir
}

/** Saldo vivo de una membresía + precio/cupo de su plan (para valorar el pasivo). */
export interface SaldoLite {
  creditos_restantes: number | null; // null = plan por tiempo (no aplica)
  precio_centavos: number | null;
  clases_incluidas: number | null;
}

export interface CreditosResult {
  /** Créditos vendidos y aún no usados (saldo vivo): el pasivo en sesiones. */
  pasivoSesiones: number;
  /** Valor en centavos de ese pasivo (saldo × precio por crédito del plan). */
  valorPasivoCentavos: number;
  /** Miembros que hoy tienen créditos sin usar. */
  miembrosConSaldo: number;
  /** Créditos vendidos en total (histórico, movimientos tipo 'alta'). */
  vendidos: number;
  /** Créditos consumidos en total (débitos + no-shows). */
  usados: number;
  /** usados ÷ vendidos, en %. null si aún no se ha vendido nada. */
  tasaUsoPct: number | null;
}

export function calcularCreditos(
  movimientos: MovimientoLite[],
  saldos: SaldoLite[]
): CreditosResult {
  let vendidos = 0;
  let usados = 0;
  for (const m of movimientos) {
    if (m.tipo === 'alta') vendidos += Math.max(0, m.delta);
    else if (m.tipo === 'debito' || m.tipo === 'no_show') usados += Math.abs(m.delta);
  }

  let pasivoSesiones = 0;
  let valorPasivoCentavos = 0;
  let miembrosConSaldo = 0;
  for (const s of saldos) {
    const c = s.creditos_restantes;
    if (c == null || c <= 0) continue;
    pasivoSesiones += c;
    miembrosConSaldo += 1;
    if (s.precio_centavos != null && s.clases_incluidas != null && s.clases_incluidas > 0) {
      valorPasivoCentavos += Math.round(c * (s.precio_centavos / s.clases_incluidas));
    }
  }

  const tasaUsoPct = vendidos > 0 ? (usados / vendidos) * 100 : null;

  return { pasivoSesiones, valorPasivoCentavos, miembrosConSaldo, vendidos, usados, tasaUsoPct };
}
