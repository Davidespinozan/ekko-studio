import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sun, CloudSun, Moon, Eye, Ban, ArrowRight, ArrowUp, ArrowDown, PartyPopper } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { useDashboardData, useDineroMetrics, type DashboardData } from '../hooks/useAdminData';
import CardMenuDropdown from '../components/CardMenuDropdown';
import CancelarReservaModal, { type ReservaParaCancelar } from '../components/CancelarReservaModal';
import { CentroPendientes } from '../components/CentroPendientes';
import { CumpleanosCard } from '@shared/components/CumpleanosCard';

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function saludoTiming(d: Date = new Date()): { texto: string; icon: LucideIcon } {
  const h = d.getHours();
  if (h >= 5 && h < 12) return { texto: 'Buenos días', icon: Sun };
  if (h >= 12 && h < 19) return { texto: 'Buenas tardes', icon: CloudSun };
  return { texto: 'Buenas noches', icon: Moon };
}

function nombreMes(d: Date): string {
  return d.toLocaleDateString('es-MX', { month: 'long' });
}

function calcTendencia(actual: number, anterior: number): number | null {
  if (anterior === 0) return null;
  return ((actual - anterior) / anterior) * 100;
}

export default function AdminDashboard() {
  const { usuario } = useAuth();
  const { data, isLoading, error, refetch } = useDashboardData();
  const [cancelar, setCancelar] = useState<ReservaParaCancelar | null>(null);

  const saludo = saludoTiming();
  const SaludoIcon = saludo.icon;
  const nombre = capitalizar(usuario?.nombre).split(' ')[0] || '';

  if (isLoading) {
    return (
      <div>
        <div className="ek-skeleton" style={{ height: '40px', width: '260px', marginBottom: '12px' }} />
        <div className="ek-skeleton" style={{ height: '20px', width: '180px', marginBottom: '32px' }} />
        <div className="ek-skeleton" style={{ height: '300px', marginBottom: '20px' }} />
        <div className="ek-skeleton" style={{ height: '200px' }} />
      </div>
    );
  }

  // ERROR-UI-FIX E-03: si alguna query del dashboard falló, mostrar el error
  // con opción de reintentar — NO un dashboard en cero que parece real.
  if (error || !data) {
    return (
      <div className="ek-card" style={{ textAlign: 'center', padding: '40px 24px' }}>
        <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)', marginBottom: '8px' }}>
          ERROR
        </p>
        <p className="ek-body" style={{ marginBottom: '20px' }}>
          No se pudo cargar el dashboard. Verifica tu conexión e intenta de nuevo.
        </p>
        <button type="button" onClick={() => void refetch()} className="ek-cta" style={{ minHeight: '44px' }}>
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(32px, 5vw, 48px)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1.05,
          margin: 0,
          marginBottom: '6px'
        }}
      >
        Hoy en EKKO
      </h1>
      <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '36px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        {saludo.texto}{nombre ? `, ${nombre}` : ''}
        <SaludoIcon size={15} aria-hidden="true" />
      </p>

      <CentroPendientes />
      <CumpleanosCard />
      <SeccionHoy data={data} onCancelar={setCancelar} />
      <PulsoDelMes data={data} />

      {cancelar && (
        <CancelarReservaModal
          reserva={cancelar}
          onClose={() => setCancelar(null)}
          onCancelled={async () => {
            await refetch();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// SECCIÓN HOY
// ============================================================================

function SeccionHoy({
  data,
  onCancelar
}: {
  data: DashboardData;
  onCancelar: (r: ReservaParaCancelar) => void;
}) {
  const toast = useToast();
  const hoy = new Date();
  const fechaFmt = hoy.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });

  const top = data.reservasHoy.slice(0, 3);
  const total = data.reservasHoy.length;

  return (
    <section style={{ marginBottom: '32px' }}>
      <SectionHeader title="HOY" subtitle={fechaFmt.charAt(0).toUpperCase() + fechaFmt.slice(1)} />

      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '28px',
          fontWeight: 600,
          letterSpacing: '-0.02em',
          margin: 0,
          marginBottom: '4px'
        }}
      >
        {total} {total === 1 ? 'reserva hoy' : 'reservas hoy'}
      </p>
      {total === 0 ? (
        <p className="ek-body-faint" style={{ marginBottom: '0' }}>
          No hay reservas para hoy.
        </p>
      ) : (
        <>
          <p
            className="ek-eyebrow ek-eyebrow--mustard"
            style={{ fontSize: '10px', marginTop: '20px', marginBottom: '12px' }}
          >
            PRÓXIMAS
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {top.map((r) => {
              const fecha = new Date(r.slot_inicio);
              const hora = fecha.toLocaleTimeString('es-MX', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
              });
              const nombre = capitalizar(r.usuario?.nombre) || r.usuario?.email || '—';
              const tier = r.usuario?.membresia_tier ?? null;
              const recursoNombre = r.recurso?.nombre ?? '—';

              return (
                <div
                  key={r.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    background: 'var(--ek-bg-soft)',
                    border: '0.5px solid var(--ek-line)',
                    borderRadius: 'var(--ek-r-sm)',
                    padding: '14px 18px'
                  }}
                >
                  <div style={{ minWidth: '64px' }}>
                    <p
                      style={{
                        fontFamily: 'var(--ek-font-display)',
                        fontSize: '20px',
                        fontWeight: 700,
                        letterSpacing: '-0.02em',
                        margin: 0,
                        color: 'var(--ek-ink)'
                      }}
                    >
                      {hora}
                    </p>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        fontFamily: 'var(--ek-font-display)',
                        fontSize: '15px',
                        fontWeight: 600,
                        letterSpacing: '-0.02em',
                        margin: 0,
                        marginBottom: '2px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {nombre}
                    </p>
                    <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: 0 }}>
                      {recursoNombre}
                      {tier ? ` · ${tier}` : ''}
                    </p>
                  </div>
                  <CardMenuDropdown
                    items={[
                      {
                        label: 'Ver detalle',
                        icon: Eye,
                        onClick: () => toast.info('Detalle de reserva: pendiente Sprint Reservas.')
                      },
                      {
                        label: 'Cancelar reserva',
                        icon: Ban,
                        onClick: () =>
                          onCancelar({
                            id: r.id,
                            slot_inicio: r.slot_inicio,
                            recurso_nombre: recursoNombre,
                            usuario_nombre: nombre,
                            tier
                          }),
                        danger: true,
                        divider: true
                      }
                    ]}
                  />
                </div>
              );
            })}
          </div>
          {total > 3 && (
            <Link
              to="/admin/calendario"
              style={{
                display: 'inline-block',
                marginTop: '14px',
                fontSize: '13px',
                color: 'var(--ek-mustard)',
                textDecoration: 'none',
                fontWeight: 600
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                Ver todas las {total} reservas
                <ArrowRight size={13} aria-hidden="true" />
              </span>
            </Link>
          )}
        </>
      )}
    </section>
  );
}

// ============================================================================
// PULSO DEL MES — tira compacta (ingresos · reservas · altas · no-shows) +
// gráfica de 30 días + enlace a Reportes. El análisis profundo (MRR, ocupación,
// churn, LTV…) vive en Reportes; aquí solo el pulso glanceable, sin badges
// gigantes que duplican ese reporte.
// ============================================================================

function PulsoDelMes({ data }: { data: DashboardData }) {
  const { metrics } = useDineroMetrics();
  const ahora = new Date();
  const mesActual = nombreMes(ahora);
  const mesAnteriorNombre = nombreMes(new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1));

  const tendReservas = calcTendencia(data.reservasMesActual, data.reservasMesAnterior);
  const tendMiembros = calcTendencia(data.miembrosNuevosMesActual, data.miembrosNuevosMesAnterior);
  const tendDinero = metrics ? calcTendencia(metrics.facturadoMesActual, metrics.facturadoMesAnterior) : null;

  const pctActual =
    data.reservasMesActual > 0 ? Math.round((data.noShowsMesActual / data.reservasMesActual) * 100) : 0;
  const pctAnterior =
    data.totalReservasMesAnteriorParaNoShows > 0
      ? Math.round((data.noShowsMesAnterior / data.totalReservasMesAnteriorParaNoShows) * 100)
      : 0;
  const tendNoShows = pctAnterior === 0 ? null : pctActual - pctAnterior;

  const minis = [
    { label: 'INGRESOS', valor: metrics ? pesos(metrics.facturadoMesActual) : '—', tendencia: tendDinero },
    { label: 'RESERVAS', valor: String(data.reservasMesActual), tendencia: tendReservas },
    { label: 'ALTAS', valor: String(data.miembrosNuevosMesActual), tendencia: tendMiembros },
    { label: 'NO-SHOWS', valor: `${pctActual}%`, tendencia: tendNoShows, inversa: true }
  ];

  return (
    <section style={{ marginBottom: '28px' }}>
      <SectionHeader
        title="ESTE MES"
        subtitle={`${mesActual.charAt(0).toUpperCase() + mesActual.slice(1)} ${ahora.getFullYear()}`}
      />

      <div className="ek-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="adm-pulso-grid">
          {minis.map((m) => (
            <MiniStat key={m.label} {...m} mesAnteriorNombre={mesAnteriorNombre} />
          ))}
        </div>
      </div>

      <div style={{ marginTop: '14px' }}>
        <Grafica30Dias data={data.reservasUltimos30Dias} />
      </div>

      <Link
        to="/admin/reportes"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          marginTop: '14px',
          fontSize: '13px',
          color: 'var(--ek-mustard)',
          textDecoration: 'none',
          fontWeight: 600
        }}
      >
        Ver reportes completos · ocupación, MRR, retención
        <ArrowRight size={13} aria-hidden="true" />
      </Link>
    </section>
  );
}

function MiniStat({
  label,
  valor,
  tendencia,
  inversa = false,
  mesAnteriorNombre
}: {
  label: string;
  valor: string;
  tendencia: number | null;
  inversa?: boolean;
  mesAnteriorNombre: string;
}) {
  let txt = '';
  let color = 'var(--ek-ink-faint)';
  let Icon: LucideIcon | null = null;

  if (tendencia === null) {
    txt = 'primer mes';
    Icon = PartyPopper;
  } else if (Math.round(tendencia) === 0) {
    txt = `igual que ${mesAnteriorNombre}`;
  } else {
    Icon = tendencia >= 0 ? ArrowUp : ArrowDown;
    const positivo = inversa ? tendencia < 0 : tendencia > 0;
    color = positivo ? 'var(--ek-success)' : 'var(--ek-danger)';
    txt = `${Math.abs(Math.round(tendencia))}% vs ${mesAnteriorNombre}`;
  }

  return (
    <div className="adm-pulso-cell">
      <p className="ek-eyebrow" style={{ fontSize: '9.5px', margin: 0 }}>{label}</p>
      <p
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '24px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          lineHeight: 1,
          margin: '6px 0 0'
        }}
      >
        {valor}
      </p>
      <p
        style={{
          fontSize: '10.5px',
          color,
          margin: '6px 0 0',
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '3px',
          lineHeight: 1.2
        }}
      >
        {Icon && <Icon size={11} aria-hidden="true" style={{ flexShrink: 0 }} />}
        {txt}
      </p>
    </div>
  );
}

function Grafica30Dias({ data }: { data: Array<{ fecha: string; count: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const WIDTH = 600;
  const HEIGHT = 120;
  const BAR_W = WIDTH / data.length;
  const PAD = 1;

  return (
    <div
      className="ek-card"
      style={{ padding: '20px' }}
    >
      <p className="ek-eyebrow" style={{ fontSize: '10px', marginBottom: '12px' }}>
        RESERVAS · ÚLTIMOS 30 DÍAS
      </p>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
        role="img"
        aria-label="Reservas por día en los últimos 30 días"
      >
        {data.map((d, i) => {
          const h = (d.count / max) * (HEIGHT - 10);
          return (
            <g key={d.fecha}>
              <rect
                x={i * BAR_W + PAD}
                y={HEIGHT - h}
                width={BAR_W - PAD * 2}
                height={h}
                fill="var(--ek-mustard)"
                opacity={d.count === 0 ? 0.15 : 0.85}
                rx={2}
              >
                <title>
                  {d.count} {d.count === 1 ? 'reserva' : 'reservas'} ·{' '}
                  {new Date(d.fecha).toLocaleDateString('es-MX', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short'
                  })}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '10px',
          color: 'var(--ek-ink-faint)',
          marginTop: '6px'
        }}
      >
        <span>Hace 30 días</span>
        <span>Hoy</span>
      </div>
    </div>
  );
}

// ============================================================================
// Formateo de dinero (usado por el pulso del mes)
// ============================================================================

function pesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

// ============================================================================
// Header de sección reusable
// ============================================================================

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <p
        className="ek-eyebrow ek-eyebrow--mustard"
        style={{ fontSize: '11px', marginBottom: '2px' }}
      >
        {title}
      </p>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0 }}>{subtitle}</p>
    </div>
  );
}
