import { useReportesEconomia } from '../hooks/useReportesEconomia';
import { InfoTooltip } from '@shared/components/InfoTooltip';
import type { EconomiaResult } from '../logic/reportesEconomia';

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
  ltv: 'Valor de vida del cliente: cuánto te deja un miembro en total mientras dura (ARPU × vida media). Es el techo de lo que conviene gastar para captar un miembro nuevo. Estimado a partir del churn.'
} as const;

export default function Reportes() {
  const { data, isLoading, error } = useReportesEconomia();

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
