import { useReportesEconomia } from '../hooks/useReportesEconomia';
import { useReportesOcupacion } from '../hooks/useReportesOcupacion';
import { InfoTooltip } from '@shared/components/InfoTooltip';
import type { EconomiaResult } from '../logic/reportesEconomia';
import type { OcupacionResult } from '../logic/reportesOcupacion';

// ============================================================================
// /admin/reportes — Analítica del negocio para el dueño. Empieza con el bloque
// ECONOMÍA (negocio recurrente): MRR, ARR, ARPU, churn, vida media y LTV, más
// el desglose de ingreso por plan. Cada KPI trae un ⓘ que explica el cálculo.
// ============================================================================

function pesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

const AYUDA = {
  mrr: 'Ingreso recurrente mensual: lo que tus membresías activas facturan cada mes. Es el pulso financiero del estudio. Es ingreso contratado (según el precio de cada plan), no cobro real.',
  arr: 'El MRR proyectado a un año (MRR × 12). Muestra la escala anual del negocio si todo sigue igual.',
  arpu: 'Ingreso promedio por miembro al mes (MRR ÷ miembros con plan). Si sube, tus miembros están en planes más altos o subiste precios.',
  churn:
    'Porcentaje de miembros activos que se dan de baja cada mes, estimado con las bajas de los últimos 90 días. Es lo opuesto a la retención: cuanto más bajo, mejor. Arriba de ~10% mensual, prendé las alarmas.',
  vidaMedia:
    'Meses que dura un miembro en promedio antes de darse de baja. Cuanto más alta, mejor tu retención. Se estima como 1 ÷ churn mensual.',
  ltv: 'Valor de vida del cliente: cuánto te deja un miembro en total mientras dura (ARPU × vida media). Es el techo de lo que conviene gastar para captar un miembro nuevo. Estimado a partir del churn.',
  ocupacion:
    'Qué tan llenos están tus estudios: horas reservadas ÷ horas disponibles (según el horario de cada estudio × cupos) en los últimos 90 días. Baja ocupación = agenda vacía; muy alta = te falta capacidad.',
  asistencia:
    'De las sesiones agendadas, qué % de gente sí se presentó (completadas ÷ completadas + no-shows). Cuanto más alta, mejor. Si cae, tenés fuga de valor: reservan y no vienen.',
  noShows:
    'Reservas donde el miembro no se presentó en los últimos 90 días. Cada no-show es un slot que bloqueaste y quedó vacío. Vigilalo por estudio para detectar patrones.',
  heatmap:
    'Demanda por día y hora en los últimos 90 días: cuanto más intenso el color, más se reserva ese horario. Te dice qué franjas abrir, cuáles cerrar y dónde subir el precio.'
} as const;

export default function Reportes() {
  const { data, isLoading, error } = useReportesEconomia();
  const ocupacion = useReportesOcupacion();

  return (
    <div className="adm-page">
      <header style={{ marginBottom: '24px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '10px', marginBottom: '6px' }}>
          REPORTES
        </p>
        <h1
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '26px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: 0,
            color: 'var(--ek-ink)'
          }}
        >
          Salud del negocio
        </h1>
        <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: '4px 0 0' }}>
          Ingreso recurrente y retención. Tocá el ⓘ de cada dato para entender qué significa.
        </p>
      </header>

      <section>
        <p className="ek-eyebrow" style={{ fontSize: '10px', marginBottom: '12px' }}>
          ECONOMÍA · HOY
        </p>

        {isLoading ? (
          <div className="adm-metricas-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="ek-skeleton" style={{ height: '104px', borderRadius: 'var(--ek-r-card)' }} />
            ))}
          </div>
        ) : error || !data ? (
          <div className="ek-card" style={{ padding: '20px' }}>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
              No pudimos cargar los datos económicos. Reintentá en un momento.
            </p>
          </div>
        ) : (
          <BloqueEconomia data={data} />
        )}
      </section>

      <section>
        <p className="ek-eyebrow" style={{ fontSize: '10px', margin: '0 0 12px' }}>
          OCUPACIÓN Y ASISTENCIA · 90 DÍAS
        </p>

        {ocupacion.isLoading ? (
          <div className="adm-metricas-grid">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="ek-skeleton" style={{ height: '104px', borderRadius: 'var(--ek-r-card)' }} />
            ))}
          </div>
        ) : ocupacion.error || !ocupacion.data ? (
          <div className="ek-card" style={{ padding: '20px' }}>
            <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>
              No pudimos cargar la ocupación. Reintentá en un momento.
            </p>
          </div>
        ) : (
          <BloqueOcupacion data={ocupacion.data} />
        )}
      </section>
    </div>
  );
}

function pct(v: number | null): string {
  return v == null ? '—' : `${v.toFixed(0)}%`;
}

function BloqueOcupacion({ data }: { data: OcupacionResult }) {
  const asistBaja = data.asistenciaPct != null && data.asistenciaPct < 70;
  return (
    <>
      <div className="adm-metricas-grid">
        <KpiCard label="Ocupación" valor={pct(data.ocupacionPct)} nota="horas reservadas ÷ disponibles" ayuda={AYUDA.ocupacion} />
        <KpiCard label="Asistencia" valor={pct(data.asistenciaPct)} alerta={asistBaja} nota="se presentaron vs. agendados" ayuda={AYUDA.asistencia} />
        <KpiCard label="Reservas" valor={String(data.totalReservas)} nota={`${data.horasReservadas} h reservadas`} />
        <KpiCard label="No-shows" valor={String(data.noShows)} alerta={data.noShows > 0} nota="slots agendados y vacíos" ayuda={AYUDA.noShows} />
      </div>

      {data.heatmapMax > 0 && <Heatmap data={data} />}
      {data.porEstudio.length > 0 && <RankingEstudios data={data} />}
    </>
  );
}

const DIAS_LABEL = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function Heatmap({ data }: { data: OcupacionResult }) {
  // Recortamos a la franja con actividad para no dibujar 24h muertas.
  let minH = 23;
  let maxH = 0;
  for (const fila of data.heatmap) {
    for (let h = 0; h < 24; h++) {
      if (fila[h] > 0) {
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
  }
  if (minH > maxH) {
    minH = 8;
    maxH = 22;
  }
  const horas = Array.from({ length: maxH - minH + 1 }, (_, i) => minH + i);

  return (
    <div className="ek-card" style={{ padding: '20px', marginTop: '16px', overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '14px' }}>
        <p className="ek-eyebrow" style={{ fontSize: '10px', margin: 0 }}>
          DEMANDA POR DÍA Y HORA
        </p>
        <InfoTooltip titulo="Demanda por día y hora" texto={AYUDA.heatmap} />
      </div>
      <div style={{ minWidth: `${horas.length * 22 + 40}px` }}>
        {/* Encabezado de horas */}
        <div style={{ display: 'grid', gridTemplateColumns: `36px repeat(${horas.length}, 1fr)`, gap: '3px', marginBottom: '3px' }}>
          <span />
          {horas.map((h) => (
            <span key={h} style={{ fontSize: '9px', color: 'var(--ek-ink-faint)', textAlign: 'center' }}>
              {h}
            </span>
          ))}
        </div>
        {data.heatmap.map((fila, d) => (
          <div key={d} style={{ display: 'grid', gridTemplateColumns: `36px repeat(${horas.length}, 1fr)`, gap: '3px', marginBottom: '3px' }}>
            <span style={{ fontSize: '10px', color: 'var(--ek-ink-muted)', display: 'flex', alignItems: 'center' }}>
              {DIAS_LABEL[d]}
            </span>
            {horas.map((h) => {
              const v = fila[h];
              const intensidad = data.heatmapMax > 0 ? v / data.heatmapMax : 0;
              return (
                <div
                  key={h}
                  title={`${DIAS_LABEL[d]} ${h}:00 · ${v} ${v === 1 ? 'reserva' : 'reservas'}`}
                  style={{
                    height: '18px',
                    borderRadius: '3px',
                    background:
                      v === 0
                        ? 'var(--ek-bg-soft)'
                        : `rgba(229, 184, 41, ${0.18 + intensidad * 0.82})`
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function RankingEstudios({ data }: { data: OcupacionResult }) {
  return (
    <div className="ek-card" style={{ padding: '20px', marginTop: '16px' }}>
      <p className="ek-eyebrow" style={{ fontSize: '10px', margin: '0 0 14px' }}>
        POR ESTUDIO
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {data.porEstudio.map((e) => (
          <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ek-ink)', minWidth: '90px', flex: 1 }}>
              {e.nombre}
            </span>
            <span style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>
              {e.reservas} {e.reservas === 1 ? 'reserva' : 'reservas'}
            </span>
            <span style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', fontVariantNumeric: 'tabular-nums', minWidth: '78px' }}>
              Ocup. {pct(e.ocupacionPct)}
            </span>
            <span style={{ fontSize: '12px', color: e.asistenciaPct != null && e.asistenciaPct < 70 ? 'var(--ek-danger)' : 'var(--ek-ink-muted)', fontVariantNumeric: 'tabular-nums', minWidth: '78px' }}>
              Asist. {pct(e.asistenciaPct)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BloqueEconomia({ data }: { data: EconomiaResult }) {
  const churnTexto = data.churnMensualPct == null ? '—' : `${data.churnMensualPct.toFixed(1)}%`;
  const churnAlerta = data.churnMensualPct != null && data.churnMensualPct > 10;
  const vidaTexto = data.vidaMediaMeses == null ? '—' : `${data.vidaMediaMeses.toFixed(1)} m`;
  const ltvTexto = data.ltvCentavos == null ? '—' : pesos(data.ltvCentavos);

  return (
    <>
      <div className="adm-metricas-grid">
        <KpiCard label="MRR · ingreso recurrente" valor={pesos(data.mrrCentavos)} nota="membresías activas × precio mensual" ayuda={AYUDA.mrr} />
        <KpiCard label="ARR · anualizado" valor={pesos(data.arrCentavos)} nota="MRR × 12" ayuda={AYUDA.arr} />
        <KpiCard label="ARPU · por miembro" valor={pesos(data.arpuCentavos)} nota={`${data.activosConPlan} ${data.activosConPlan === 1 ? 'miembro' : 'miembros'} con plan`} ayuda={AYUDA.arpu} />
        <KpiCard label="Churn mensual" valor={churnTexto} alerta={churnAlerta} nota="bajas de 90 días" ayuda={AYUDA.churn} />
        <KpiCard label="Vida media del miembro" valor={vidaTexto} nota="1 ÷ churn" ayuda={AYUDA.vidaMedia} />
        <KpiCard label="LTV estimado" valor={ltvTexto} nota="ARPU × vida media" ayuda={AYUDA.ltv} />
      </div>

      {data.ingresoPorPlan.length > 0 && <IngresoPorPlan data={data} />}
    </>
  );
}

function KpiCard({
  label,
  valor,
  nota,
  ayuda,
  alerta
}: {
  label: string;
  valor: string;
  nota?: string;
  ayuda?: string;
  alerta?: boolean;
}) {
  return (
    <div className="ek-card ek-stat-card" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <p className="ek-eyebrow" style={{ fontSize: '10px', margin: 0, color: alerta ? 'var(--ek-danger)' : undefined }}>
          {label}
        </p>
        {ayuda && <InfoTooltip titulo={label} texto={ayuda} />}
      </div>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '30px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          margin: 0,
          color: alerta ? 'var(--ek-danger)' : 'var(--ek-ink)'
        }}
      >
        {valor}
      </p>
      {nota && <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', margin: 0 }}>{nota}</p>}
    </div>
  );
}

function IngresoPorPlan({ data }: { data: EconomiaResult }) {
  const max = Math.max(1, ...data.ingresoPorPlan.map((p) => p.mrrCentavos));
  return (
    <div className="ek-card" style={{ padding: '20px', marginTop: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '14px' }}>
        <p className="ek-eyebrow" style={{ fontSize: '10px', margin: 0 }}>
          INGRESO POR PLAN
        </p>
        <InfoTooltip
          titulo="Ingreso por plan"
          texto="Cuánto MRR aporta cada plan. Te dice de dónde viene tu ingreso recurrente y qué plan pesa más en el negocio."
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {data.ingresoPorPlan.map((p) => (
          <div key={p.slug}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '5px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ek-ink)' }}>
                {p.nombre}
                <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', fontWeight: 400 }}>
                  {' · '}{p.miembros} {p.miembros === 1 ? 'miembro' : 'miembros'}
                </span>
              </span>
              <span style={{ fontSize: '13px', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: 'var(--ek-ink)' }}>
                {pesos(p.mrrCentavos)}
              </span>
            </div>
            <div style={{ height: '6px', borderRadius: '3px', background: 'var(--ek-bg-soft)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${(p.mrrCentavos / max) * 100}%`,
                  background: 'var(--ek-mustard)',
                  borderRadius: '3px'
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
