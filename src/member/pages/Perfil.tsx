import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, History, LogOut, type LucideIcon } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useTenant } from '@shared/hooks/useTenant';
import { supabase } from '@shared/lib/supabase';
import { EmptyState } from '@shared/components/EmptyState';
import { MiSuscripcion } from '@member/components/MiSuscripcion';
import { ESTADOS_RESERVA_HISTORICOS } from '@shared/constants/reservaStatus';
import type { Database } from '@shared/types/database';

type Reserva = Database['public']['Tables']['reservas']['Row'];
type Recurso = Database['public']['Tables']['recursos']['Row'];

interface ReservaConRecurso extends Reserva {
  recurso: Pick<Recurso, 'nombre'> | null;
}

function useStatsDelMes(usuarioId: string | undefined) {
  const [sesionesEsteMes, setSesionesEsteMes] = useState(0);

  useEffect(() => {
    if (!usuarioId) return;
    let mounted = true;
    async function load() {
      const inicio = new Date();
      inicio.setDate(1);
      inicio.setHours(0, 0, 0, 0);

      const { count } = await supabase
        .from('reservas')
        .select('id', { count: 'exact', head: true })
        .eq('usuario_id', usuarioId!)
        .eq('status', 'completada')
        .gte('check_in_at', inicio.toISOString());

      if (mounted) setSesionesEsteMes(count ?? 0);
    }
    load();
    return () => { mounted = false; };
  }, [usuarioId]);

  return { sesionesEsteMes };
}

function useReservasPasadas(usuarioId: string | undefined) {
  const [reservas, setReservas] = useState<ReservaConRecurso[]>([]);

  useEffect(() => {
    if (!usuarioId) return;
    let mounted = true;
    async function load() {
      const { data } = await supabase
        .from('reservas')
        .select('*, recurso:recursos(nombre)')
        .eq('usuario_id', usuarioId!)
        .in('status', ESTADOS_RESERVA_HISTORICOS as unknown as string[])
        .order('slot_inicio', { ascending: false })
        .limit(20);
      if (mounted) setReservas((data ?? []) as unknown as ReservaConRecurso[]);
    }
    load();
    return () => { mounted = false; };
  }, [usuarioId]);

  return { reservas };
}

function formatearFecha(iso: string): string {
  const d = new Date(iso);
  const fecha = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fecha} · ${hora}`;
}

function badgeParaReserva(status: string): { label: string; className: string; icon: LucideIcon } {
  if (status === 'completada') return { label: 'OK', className: 'ek-badge ek-badge--success', icon: CheckCircle2 };
  if (status === 'cancelada') return { label: 'CANCELADA', className: 'ek-badge ek-badge--neutral', icon: XCircle };
  if (status === 'cancelada_admin')
    return { label: 'CANCELADA · ESTUDIO', className: 'ek-badge ek-badge--danger', icon: XCircle };
  if (status === 'no_show') return { label: 'NO SHOW', className: 'ek-badge ek-badge--danger', icon: AlertTriangle };
  return { label: status.toUpperCase(), className: 'ek-badge ek-badge--neutral', icon: AlertTriangle };
}

export default function Perfil() {
  const { authUser, usuario, signOut } = useAuth();
  const tenant = useTenant();
  const { reservas } = useReservasPasadas(usuario?.id);
  const { sesionesEsteMes } = useStatsDelMes(usuario?.id);

  const nombreFormat = usuario?.nombre
    ?.toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') ?? '';

  const initials = (usuario?.nombre ?? usuario?.email ?? '?')
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <div className="ek-stack-md">
          <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar">PERFIL</p>
          <h1 className="ek-display-md">{nombreFormat || 'Tu cuenta'}</h1>
        </div>

        {/* Avatar */}
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <span className="ek-avatar-ring">
            {usuario?.avatar_url ? (
              <img
                src={usuario.avatar_url}
                alt={usuario.nombre ?? 'Avatar'}
                style={{
                  width: '120px',
                  height: '120px',
                  borderRadius: '50%',
                  objectFit: 'cover'
                }}
              />
            ) : (
              <div style={{
                width: '120px',
                height: '120px',
                borderRadius: '50%',
                background: 'linear-gradient(135deg, var(--ek-bg-elevated), var(--ek-bg-soft))',
                color: 'var(--ek-mustard)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--ek-font-display)',
                fontSize: '40px',
                fontWeight: 700,
                letterSpacing: '-0.04em'
              }}>
                {initials}
              </div>
            )}
          </span>
        </div>

        <div className="adm-info-grid perfil-info-grid">
          <div className="adm-info-cell">
            <p className="adm-info-label">Email</p>
            <p className="adm-info-value">{authUser?.email}</p>
          </div>
          {usuario?.telefono && (
            <div className="adm-info-cell">
              <p className="adm-info-label">Teléfono</p>
              <p className="adm-info-value">{usuario.telefono}</p>
            </div>
          )}
          <div className="adm-info-cell">
            <p className="adm-info-label">Tenant</p>
            <p className="adm-info-value">{tenant.nombre}</p>
          </div>
          <div className="adm-info-cell">
            <p className="adm-info-label">Rol</p>
            <p className="adm-info-value adm-info-value--mono">{usuario?.rol}</p>
          </div>
          <div className="adm-info-cell">
            <p className="adm-info-label">Status</p>
            <p className="adm-info-value adm-info-value--mono">{usuario?.status}</p>
          </div>
        </div>

        {/* Mi suscripción */}
        {usuario?.id && (
          <MiSuscripcion
            usuarioId={usuario.id}
            tierSlug={usuario.membresia_tier ?? null}
            status={usuario.status}
          />
        )}

        {/* Stat del mes */}
        <section style={{ marginTop: '32px', marginBottom: '24px' }}>
          <div className="ek-stat-card" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <div>
              <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '6px' }}>ESTE MES</p>
              <p className="ek-kpi">
                {sesionesEsteMes}{' '}
                <span style={{
                  fontSize: '15px',
                  fontWeight: 500,
                  color: 'var(--ek-ink-muted)',
                  letterSpacing: 'normal'
                }}>
                  {sesionesEsteMes === 1 ? 'sesión completada' : 'sesiones completadas'}
                </span>
              </p>
            </div>
          </div>
        </section>

        {/* Reservas pasadas */}
        <section>
          <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ marginBottom: '12px' }}>HISTORIAL</p>
          <h2 className="ek-display-md" style={{ marginBottom: '16px' }}>Reservas pasadas</h2>

          {reservas.length === 0 ? (
            <EmptyState
              icon={History}
              tone="neutral"
              title="Sin historial todavía"
              hint="Aún no tienes sesiones completadas. Cuando termines una grabación aparecerá acá."
            />
          ) : (
            <div className="ek-stack-sm">
              {reservas.map((r) => {
                const badge = badgeParaReserva(r.status);
                const esCanceladaAdmin = r.status === 'cancelada_admin';
                const esCanceladaUsuario = r.status === 'cancelada';
                return (
                  <div
                    key={r.id}
                    className="ek-card ek-card--md"
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      gap: '12px'
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p
                        style={{
                          fontFamily: 'var(--ek-font-display)',
                          fontSize: '14px',
                          fontWeight: 600,
                          letterSpacing: '-0.02em',
                          margin: 0
                        }}
                      >
                        {r.recurso?.nombre ?? 'Estudio'}
                      </p>
                      <p className="ek-body-faint" style={{ marginTop: '2px' }}>
                        {formatearFecha(r.slot_inicio)}
                      </p>
                      {(esCanceladaAdmin || esCanceladaUsuario) && (
                        <p
                          style={{
                            fontSize: '11px',
                            color: 'var(--ek-ink-muted)',
                            marginTop: '4px',
                            lineHeight: 1.4
                          }}
                        >
                          {esCanceladaAdmin
                            ? 'Cancelada por el estudio'
                            : 'La cancelaste'}
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
          )}
        </section>

        <button onClick={signOut} className="ek-cta ek-cta--secondary ek-cta--full">
          <LogOut size={16} aria-hidden="true" /> Cerrar sesión
        </button>
      </div>
    </div>
  );
}
