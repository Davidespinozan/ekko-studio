import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '@shared/lib/supabase';
import { statusMiembro } from '../lib/miembroStatus';

/**
 * Perfil de miembro READ-ONLY para recepción (Sprint RP-2).
 *
 * Vista NUEVA — NO reusa `MiembroDetalle` de admin (riesgo R3: ese
 * componente edita status/rol/tier, resetea password y borra). Acá
 * recepción solo CONSULTA. Tampoco se leen campos sensibles
 * (stripe_customer_id, ob_data — riesgo R6): el SELECT ni los pide.
 *
 * Las acciones de reserva (crear/cancelar/reprogramar) son RP-3 y
 * van a colgar de esta vista — ver el marcador más abajo.
 */

interface MiembroPerfil {
  id: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
  membresia_tier: string | null;
  status: string;
  no_shows_count: number | null;
  bloqueado_hasta: string | null;
  created_at: string;
}

interface ReservaPerfil {
  id: string;
  slot_inicio: string;
  status: string;
  folio: string;
  recurso: { nombre: string } | null;
}

function capitalizar(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function fechaHora(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

export default function PerfilMiembroRecepcion() {
  const { id } = useParams<{ id: string }>();
  const [miembro, setMiembro] = useState<MiembroPerfil | null>(null);
  const [reservas, setReservas] = useState<ReservaPerfil[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [noEncontrado, setNoEncontrado] = useState(false);

  useEffect(() => {
    if (!id) return;
    let mounted = true;
    setIsLoading(true);
    setNoEncontrado(false);

    async function load() {
      // SELECT explícito — NO se piden stripe_customer_id ni ob_data (R6).
      const { data: m, error } = await supabase
        .from('usuarios')
        .select('id, nombre, email, telefono, membresia_tier, status, no_shows_count, bloqueado_hasta, created_at')
        .eq('id', id!)
        .maybeSingle();

      if (!mounted) return;
      if (error || !m) {
        setNoEncontrado(true);
        setIsLoading(false);
        return;
      }
      setMiembro(m as MiembroPerfil);

      const { data: r } = await supabase
        .from('reservas')
        .select('id, slot_inicio, status, folio, recurso:recursos(nombre)')
        .eq('usuario_id', id!)
        .order('slot_inicio', { ascending: false })
        .limit(50);

      if (!mounted) return;
      setReservas((r ?? []) as unknown as ReservaPerfil[]);
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [id]);

  if (isLoading) {
    return (
      <div className="rec-main">
        <div className="ek-skeleton" style={{ height: '40px', width: '50%', marginBottom: '16px' }} />
        <div className="ek-skeleton" style={{ height: '160px', borderRadius: 'var(--ek-r-md)' }} />
      </div>
    );
  }

  if (noEncontrado || !miembro) {
    return (
      <div className="rec-main">
        <Link to="/recepcion/miembros" className="adm-link">← Volver a búsqueda</Link>
        <p className="ek-body" style={{ marginTop: '16px' }}>Miembro no encontrado.</p>
      </div>
    );
  }

  const st = statusMiembro(miembro.status);
  const bloqueado =
    miembro.bloqueado_hasta != null &&
    new Date(miembro.bloqueado_hasta).getTime() > Date.now();

  const ahora = Date.now();
  const proximas = reservas.filter(
    (r) => r.status === 'confirmada' && new Date(r.slot_inicio).getTime() > ahora
  );
  const historial = reservas.filter((r) => !proximas.includes(r));

  return (
    <div className="rec-main">
      <Link to="/recepcion/miembros" className="adm-link">← Volver a búsqueda</Link>

      <div style={{ marginTop: '12px', marginBottom: '20px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px' }}>
          MIEMBRO
        </p>
        <h1
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: '24px',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: 0,
            color: 'var(--ek-ink)'
          }}
        >
          {capitalizar(miembro.nombre) || miembro.email}
        </h1>
      </div>

      {/* Estado de cuenta — recepción debe poder explicárselo al cliente. */}
      {(st.alerta || bloqueado) && (
        <div
          style={{
            background: 'var(--ek-bg-soft)',
            border: `0.5px solid ${st.color}`,
            borderLeft: `3px solid ${st.color}`,
            borderRadius: 'var(--ek-r-md)',
            padding: '12px 14px',
            marginBottom: '16px'
          }}
        >
          <p style={{ fontSize: '13px', fontWeight: 600, color: st.color, margin: 0 }}>
            {st.label}
          </p>
          {miembro.status !== 'activo' && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '4px 0 0' }}>
              La cuenta no está activa. Derivá al cliente con administración.
            </p>
          )}
          {bloqueado && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '4px 0 0' }}>
              Restricción para reservar hasta el{' '}
              {fechaCorta(miembro.bloqueado_hasta as string)} (penalización por inasistencia).
            </p>
          )}
        </div>
      )}

      {/* Datos operativos */}
      <div
        style={{
          background: 'var(--ek-bg-soft)',
          border: '0.5px solid var(--ek-line)',
          borderRadius: 'var(--ek-r-md)',
          padding: '14px 16px',
          marginBottom: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px'
        }}
      >
        <Dato label="Email" valor={miembro.email} />
        {miembro.telefono && <Dato label="Teléfono" valor={miembro.telefono} />}
        <Dato label="Plan" valor={miembro.membresia_tier ?? 'Sin plan'} />
        <Dato
          label="Estado"
          valor={<span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>}
        />
        <Dato label="Inasistencias" valor={String(miembro.no_shows_count ?? 0)} />
        <Dato label="Miembro desde" valor={fechaCorta(miembro.created_at)} />
      </div>

      {/* RP-3: acá van las acciones (crear / cancelar / reprogramar reserva).
          No se implementan en RP-2 — solo el perfil read-only. */}

      <Seccion titulo="PRÓXIMAS RESERVAS">
        {proximas.length === 0 ? (
          <p className="ek-body-faint">Sin reservas próximas.</p>
        ) : (
          proximas.map((r) => <FilaReserva key={r.id} reserva={r} />)
        )}
      </Seccion>

      <Seccion titulo={`HISTORIAL (${historial.length})`}>
        {historial.length === 0 ? (
          <p className="ek-body-faint">Sin reservas anteriores.</p>
        ) : (
          historial.slice(0, 15).map((r) => <FilaReserva key={r.id} reserva={r} historico />)
        )}
      </Seccion>
    </div>
  );
}

function Dato({ label, valor }: { label: string; valor: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
      <span style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: '13px', color: 'var(--ek-ink)', textAlign: 'right' }}>
        {valor}
      </span>
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '20px' }}>
      <p className="ek-eyebrow" style={{ marginBottom: '10px' }}>{titulo}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>{children}</div>
    </section>
  );
}

function FilaReserva({ reserva, historico }: { reserva: ReservaPerfil; historico?: boolean }) {
  const cancelada = reserva.status === 'cancelada' || reserva.status === 'cancelada_admin';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        background: 'var(--ek-bg-soft)',
        border: '0.5px solid var(--ek-line)',
        borderRadius: 'var(--ek-r-sm)',
        opacity: historico && cancelada ? 0.55 : 1
      }}
    >
      <span
        style={{
          fontFamily: 'var(--ek-font-mono)',
          fontSize: '13px',
          fontWeight: 600,
          color: 'var(--ek-ink)',
          minWidth: '92px'
        }}
      >
        {fechaHora(reserva.slot_inicio)}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: '13px', color: 'var(--ek-ink-muted)' }}>
        {reserva.recurso?.nombre ?? '—'}
      </span>
      <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', flexShrink: 0 }}>
        {reserva.status}
      </span>
    </div>
  );
}
