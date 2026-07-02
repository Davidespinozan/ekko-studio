import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarPlus,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  History,
  QrCode,
  type LucideIcon
} from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { supabase } from '@shared/lib/supabase';
import { EmptyState } from '@shared/components/EmptyState';
import { ESTADOS_RESERVA_HISTORICOS } from '@shared/constants/reservaStatus';
import { agruparPorDia } from '@member/logic/agruparReservas';
import type { Database } from '@shared/types/database';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'nombre'> | null;
}

type Tab = 'proximas' | 'historial';

// ============================================================================
// Datos
// ============================================================================

function useMisReservas(usuarioId: string | undefined) {
  const [proximas, setProximas] = useState<ReservaConRecurso[]>([]);
  const [historial, setHistorial] = useState<ReservaConRecurso[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!usuarioId) {
      setIsLoading(false);
      return;
    }
    let mounted = true;
    setIsLoading(true);

    async function load() {
      const ahoraIso = new Date().toISOString();
      const [proxRes, histRes] = await Promise.all([
        supabase
          .from('reservas')
          .select('*, recurso:recursos(nombre)')
          .eq('usuario_id', usuarioId!)
          .eq('status', 'confirmada')
          .gte('slot_inicio', ahoraIso)
          .order('slot_inicio', { ascending: true }),
        supabase
          .from('reservas')
          .select('*, recurso:recursos(nombre)')
          .eq('usuario_id', usuarioId!)
          .in('status', ESTADOS_RESERVA_HISTORICOS as unknown as string[])
          .order('slot_inicio', { ascending: false })
          .limit(30)
      ]);
      if (!mounted) return;
      setProximas((proxRes.data ?? []) as unknown as ReservaConRecurso[]);
      setHistorial((histRes.data ?? []) as unknown as ReservaConRecurso[]);
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [usuarioId]);

  return { proximas, historial, isLoading };
}

// ============================================================================
// Helpers
// ============================================================================

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function badgeParaReserva(status: string): { label: string; className: string; icon: LucideIcon } {
  if (status === 'completada') return { label: 'OK', className: 'ek-badge ek-badge--success', icon: CheckCircle2 };
  if (status === 'cancelada') return { label: 'CANCELADA', className: 'ek-badge ek-badge--neutral', icon: XCircle };
  if (status === 'cancelada_admin')
    return { label: 'CANCELADA · ESTUDIO', className: 'ek-badge ek-badge--danger', icon: XCircle };
  if (status === 'no_show') return { label: 'NO SHOW', className: 'ek-badge ek-badge--danger', icon: AlertTriangle };
  return { label: status.toUpperCase(), className: 'ek-badge ek-badge--neutral', icon: AlertTriangle };
}

// ============================================================================
// Página
// ============================================================================

export default function MisReservas() {
  const { usuario } = useAuth();
  const { proximas, historial, isLoading } = useMisReservas(usuario?.id);
  const [tab, setTab] = useState<Tab>('proximas');

  const gruposProximas = agruparPorDia(proximas);
  const gruposHistorial = agruparPorDia(historial);

  return (
    <div className="ek-container">
      <div className="ek-stack-md" style={{ marginBottom: '20px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar">TUS SESIONES</p>
        <h1 className="ek-display-md">Mis reservas</h1>
      </div>

      {/* Toggle de tabs */}
      <div className="ek-tabs" role="tablist" aria-label="Filtrar reservas">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'proximas'}
          className={`ek-tab ${tab === 'proximas' ? 'ek-tab--active' : ''}`}
          onClick={() => setTab('proximas')}
        >
          Próximas{proximas.length > 0 && <span className="ek-tab-count">{proximas.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'historial'}
          className={`ek-tab ${tab === 'historial' ? 'ek-tab--active' : ''}`}
          onClick={() => setTab('historial')}
        >
          Historial{historial.length > 0 && <span className="ek-tab-count">{historial.length}</span>}
        </button>
      </div>

      {isLoading ? (
        <div className="ek-stack-sm" style={{ marginTop: '20px' }}>
          <div className="ek-skeleton" style={{ height: '72px', borderRadius: 'var(--ek-r-md)' }} />
          <div className="ek-skeleton" style={{ height: '72px', borderRadius: 'var(--ek-r-md)' }} />
        </div>
      ) : tab === 'proximas' ? (
        proximas.length === 0 ? (
          <div style={{ marginTop: '8px' }}>
            <EmptyState
              icon={CalendarPlus}
              title="Sin sesiones agendadas"
              hint="Reserva tu próxima grabación y aparecerá acá."
              action={
                <Link to="/app/reservar" className="ek-cta ek-cta--gold">
                  Reservar sesión <ArrowRight size={16} aria-hidden="true" />
                </Link>
              }
            />
          </div>
        ) : (
          <div className="ek-stack-lg" style={{ marginTop: '20px' }}>
            {gruposProximas.map((grupo) => (
              <section key={grupo.key}>
                <p className="ek-day-heading">{grupo.label}</p>
                <div className="ek-stack-sm">
                  {grupo.items.map((r) => (
                    <Link
                      key={r.id}
                      to={`/app/qr/${r.id}`}
                      className="ek-card ek-card--md ek-card-interactive ek-lift"
                      style={{ display: 'flex', alignItems: 'center', gap: '12px', textDecoration: 'none' }}
                    >
                      <span className="ek-empty-icon" style={{ width: 42, height: 42, margin: 0, flexShrink: 0 }}>
                        <QrCode size={18} aria-hidden="true" />
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '15px', fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>
                          {r.recurso?.nombre ?? 'Estudio'}
                        </p>
                        <p className="ek-body-faint" style={{ marginTop: '2px' }}>
                          {hora(r.slot_inicio)} · Folio{' '}
                          <span style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.folio}</span>
                        </p>
                      </div>
                      <ArrowRight size={16} className="ek-quick-action-arrow" aria-hidden="true" />
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )
      ) : historial.length === 0 ? (
        <div style={{ marginTop: '8px' }}>
          <EmptyState
            icon={History}
            tone="neutral"
            title="Sin historial todavía"
            hint="Aún no tienes sesiones completadas. Cuando termines una grabación aparecerá acá."
          />
        </div>
      ) : (
        <div className="ek-stack-lg" style={{ marginTop: '20px' }}>
          {gruposHistorial.map((grupo) => (
            <section key={grupo.key}>
              <p className="ek-day-heading">{grupo.label}</p>
              <div className="ek-stack-sm">
                {grupo.items.map((r) => {
                  const badge = badgeParaReserva(r.status);
                  const esCanceladaAdmin = r.status === 'cancelada_admin';
                  const esCanceladaUsuario = r.status === 'cancelada';
                  return (
                    <div
                      key={r.id}
                      className="ek-card ek-card--md"
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <p style={{ fontFamily: 'var(--ek-font-display)', fontSize: '14px', fontWeight: 600, letterSpacing: '-0.02em', margin: 0 }}>
                          {r.recurso?.nombre ?? 'Estudio'}
                        </p>
                        <p className="ek-body-faint" style={{ marginTop: '2px' }}>{hora(r.slot_inicio)}</p>
                        {(esCanceladaAdmin || esCanceladaUsuario) && (
                          <p style={{ fontSize: '11px', color: 'var(--ek-ink-muted)', marginTop: '4px', lineHeight: 1.4 }}>
                            {esCanceladaAdmin ? 'Cancelada por el estudio' : 'La cancelaste'}
                            {r.cancelada_motivo && ` · ${r.cancelada_motivo}`}
                          </p>
                        )}
                      </div>
                      <span className={badge.className} style={{ flexShrink: 0 }}>
                        <badge.icon size={12} aria-hidden="true" />
                        {badge.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
