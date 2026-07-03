// ============================================================================
// reportesResumen — convierte los KPIs ya calculados (economía, ocupación,
// engagement, créditos) en un "resumen ejecutivo": 3-5 conclusiones en lenguaje
// claro, con semáforo y acción. La idea: el dueño no interpreta números, lee qué
// está bien, qué está mal y qué hacer.
//
// Pura para testearla sin datos ni UI. Recibe los resultados (nullable: cada
// dimensión puede no haber cargado) y devuelve los insights ordenados por
// severidad (rojo → ámbar → verde), tope 5.
// ============================================================================

import type { EconomiaResult } from './reportesEconomia';
import type { OcupacionResult } from './reportesOcupacion';
import type { EngagementResult } from './reportesEngagement';
import type { CreditosResult } from './reportesCreditos';

export type TonoResumen = 'good' | 'warn' | 'bad';

export interface Insight {
  tono: TonoResumen;
  texto: string;
}

function pesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

export function generarResumen(
  eco: EconomiaResult | null,
  ocu: OcupacionResult | null,
  eng: EngagementResult | null,
  cre: CreditosResult | null
): Insight[] {
  const items: Insight[] = [];

  // ── Ocupación: el pulso #1 de un negocio de renta ────────────────────────
  if (ocu && ocu.ocupacionPct != null && ocu.totalReservas > 0) {
    const p = Math.round(ocu.ocupacionPct);
    if (p < 30) {
      items.push({ tono: 'bad', texto: `Ocupación baja (${p}%): tus estudios están casi vacíos. Activa promociones en las horas muertas — revisa el heatmap de demanda.` });
    } else if (p < 60) {
      items.push({ tono: 'warn', texto: `Ocupación media (${p}%): hay agenda por llenar. El heatmap te dice qué horarios empujar.` });
    } else if (p >= 85) {
      items.push({ tono: 'good', texto: `Ocupación muy alta (${p}%): casi lleno. Considera subir el precio en las horas pico o abrir más capacidad.` });
    } else {
      items.push({ tono: 'good', texto: `Ocupación sana (${p}%): buen nivel de uso de tus estudios.` });
    }
  }

  // ── Churn ────────────────────────────────────────────────────────────────
  if (eco && eco.churnMensualPct != null && eco.churnMensualPct > 10) {
    items.push({ tono: 'bad', texto: `Churn alto (${eco.churnMensualPct.toFixed(1)}%/mes): pierdes miembros rápido. Enfócate en retención (mira los que están en riesgo).` });
  }

  // ── Miembros en riesgo de baja ───────────────────────────────────────────
  if (eng && eng.enRiesgo.length > 0) {
    const n = eng.enRiesgo.length;
    items.push({
      tono: n >= 3 ? 'bad' : 'warn',
      texto: `${n} ${n === 1 ? 'miembro' : 'miembros'} en riesgo de baja (no vienen hace más de 21 días). Contáctalos antes de perderlos.`
    });
  }

  // ── Créditos sin usar (pasivo / churn silencioso) ────────────────────────
  if (cre && cre.tasaUsoPct != null && cre.vendidos > 0 && cre.tasaUsoPct < 55) {
    items.push({
      tono: cre.tasaUsoPct < 35 ? 'bad' : 'warn',
      texto: `Solo ${Math.round(cre.tasaUsoPct)}% de los créditos vendidos se han usado — ${pesos(cre.valorPasivoCentavos)} en sesiones pagadas y sin consumir. Empuja a esos miembros a reservar.`
    });
  }

  // ── Activación (onboarding) ──────────────────────────────────────────────
  if (eng && eng.activacionPct != null && eng.cohorteNuevos >= 3 && eng.activacionPct < 50) {
    items.push({ tono: 'warn', texto: `Activación baja (${Math.round(eng.activacionPct)}%): muchos miembros nuevos no han hecho su primera reserva. Mejora el primer contacto.` });
  }

  // ── Miembros que pagan y no vienen ───────────────────────────────────────
  if (eng && eng.porcentajeVienen != null && eng.activos >= 3 && eng.porcentajeVienen < 50) {
    items.push({ tono: 'warn', texto: `Solo ${Math.round(eng.porcentajeVienen)}% de tus miembros con plan vinieron en 30 días: pagan y no usan.` });
  }

  // ── Asistencia / no-shows ────────────────────────────────────────────────
  if (ocu && ocu.asistenciaPct != null && ocu.noShows > 0 && ocu.asistenciaPct < 80) {
    items.push({ tono: 'warn', texto: `Asistencia ${Math.round(ocu.asistenciaPct)}% (${ocu.noShows} no-shows): gente que reserva y no viene, bloqueando slots.` });
  }

  const peso: Record<TonoResumen, number> = { bad: 0, warn: 1, good: 2 };
  items.sort((a, b) => peso[a.tono] - peso[b.tono]);
  const top = items.slice(0, 5);

  // Si no salió ningún foco pero SÍ hay actividad → mensaje positivo de cierre.
  const hayActividad = (eco?.activosConPlan ?? 0) > 0 || (ocu?.totalReservas ?? 0) > 0;
  if (top.length === 0 && hayActividad) {
    const mrr = eco && eco.mrrCentavos > 0 ? ` Tu ingreso recurrente es ${pesos(eco.mrrCentavos)}/mes.` : '';
    top.push({ tono: 'good', texto: `Sin focos rojos en tus números por ahora.${mrr}` });
  }

  return top;
}
