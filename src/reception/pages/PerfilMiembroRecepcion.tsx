import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, UserX, Camera, Pencil, KeyRound, Unlock, CalendarPlus, Send } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { EmptyState } from '@shared/components/EmptyState';
import { TierBadge } from '@shared/components/TierBadge';
import { StatusBadge } from '@shared/components/StatusBadge';
import { NotasMiembro } from '@shared/components/NotasMiembro';
import { EnviarAvisoModal } from '@shared/components/EnviarAvisoModal';
import { statusMiembro } from '../lib/miembroStatus';
import { CrearReservaModal, type ReservaOriginal } from '../components/CrearReservaModal';
import {
  CancelarReservaRecepcionModal,
  type ReservaParaCancelar
} from '../components/CancelarReservaRecepcionModal';
import { EditarMiembroModal } from '../components/EditarMiembroModal';
import { FotoMiembroModal } from '../components/FotoMiembroModal';
import { ResetPasswordModal } from '../components/ResetPasswordModal';
import { DesbloquearModal } from '../components/DesbloquearModal';
import { useAuditLogDeUsuario, type AuditEntryUsuario } from '../hooks/useAuditLogDeUsuario';

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
  avatar_url: string | null;
  membresia_tier: string | null;
  status: string;
  no_shows_count: number | null;
  bloqueado_hasta: string | null;
  created_at: string;
}

interface ReservaPerfil {
  id: string;
  slot_inicio: string;
  slot_fin: string;
  status: string;
  folio: string;
  recurso_id: string;
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
  const [crearOpen, setCrearOpen] = useState(false);
  const [cancelarTarget, setCancelarTarget] = useState<ReservaParaCancelar | null>(null);
  const [reprogramarTarget, setReprogramarTarget] = useState<ReservaOriginal | null>(null);
  const [editarOpen, setEditarOpen] = useState(false);
  const [fotoOpen, setFotoOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [desbloquearOpen, setDesbloquearOpen] = useState(false);
  const [avisoOpen, setAvisoOpen] = useState(false);
  const {
    entries: auditEntries,
    isLoading: auditLoading,
    error: auditError,
    recargar: recargarAudit
  } = useAuditLogDeUsuario(id);

  const recargarReservas = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('reservas')
      .select('id, slot_inicio, slot_fin, status, folio, recurso_id, recurso:recursos(nombre)')
      .eq('usuario_id', id)
      .order('slot_inicio', { ascending: false })
      .limit(50);
    setReservas((data ?? []) as unknown as ReservaPerfil[]);
  }, [id]);

  const recargarMiembro = useCallback(async () => {
    if (!id) return;
    // SELECT explícito — NO se piden stripe_customer_id ni ob_data (R6).
    const { data: m, error } = await supabase
      .from('usuarios')
      .select('id, nombre, email, telefono, avatar_url, membresia_tier, status, no_shows_count, bloqueado_hasta, created_at')
      .eq('id', id!)
      .maybeSingle();
    if (error || !m) {
      setNoEncontrado(true);
      return;
    }
    setMiembro(m as MiembroPerfil);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let mounted = true;
    setIsLoading(true);
    setNoEncontrado(false);

    async function load() {
      await recargarMiembro();
      if (!mounted) return;
      await recargarReservas();
      if (!mounted) return;
      setIsLoading(false);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [id, recargarMiembro, recargarReservas]);

  // Tras una acción de cuenta: recargar datos del miembro + su historial de cambios.
  const recargarPerfil = useCallback(async () => {
    await recargarMiembro();
    await recargarAudit();
  }, [recargarMiembro, recargarAudit]);

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
        <Link
          to="/recepcion/miembros"
          className="adm-link"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <ArrowLeft size={15} aria-hidden="true" />
          Volver a búsqueda
        </Link>
        <EmptyState
          icon={UserX}
          title="Miembro no encontrado"
          hint="No pudimos cargar este perfil. Volvé a la búsqueda e intentá de nuevo."
          tone="danger"
        />
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
      <Link
        to="/recepcion/miembros"
        className="adm-link"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Volver a búsqueda
      </Link>

      <div style={{ marginTop: '12px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '14px' }}>
        {/* Avatar editable: recepción toma/cambia la foto del cliente */}
        <button
          type="button"
          onClick={() => setFotoOpen(true)}
          aria-label="Cambiar foto"
          style={{
            position: 'relative', width: '64px', height: '64px', flexShrink: 0,
            borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer', background: 'none'
          }}
        >
          {miembro.avatar_url ? (
            <img src={miembro.avatar_url} alt={miembro.nombre ?? 'Miembro'} style={{ width: '64px', height: '64px', borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
          ) : (
            <span style={{
              width: '64px', height: '64px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--ek-bg-elevated)', color: 'var(--ek-mustard)',
              fontFamily: 'var(--ek-font-display)', fontSize: '22px', fontWeight: 700, border: '0.5px solid var(--ek-line)'
            }}>{iniciales(miembro.nombre, miembro.email)}</span>
          )}
          <span className="ek-media-ctrl" style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '26px', height: '26px', boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }}>
            <Camera size={13} aria-hidden="true" />
          </span>
        </button>
        <div style={{ minWidth: 0 }}>
          <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar" style={{ marginBottom: '4px' }}>
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
              La cuenta no está activa. Podés activarla en <strong>Editar miembro</strong>.
            </p>
          )}
          {bloqueado && (
            <>
              <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '4px 0 8px' }}>
                Restricción para reservar hasta el{' '}
                {fechaCorta(miembro.bloqueado_hasta as string)} (penalización por inasistencia).
              </p>
              <button
                type="button"
                onClick={() => setDesbloquearOpen(true)}
                className="ek-cta ek-cta--secondary"
                style={{ minHeight: '40px', padding: '8px 14px', fontSize: '13px' }}
              >
                <Unlock size={15} aria-hidden="true" /> Desbloquear ahora
              </button>
            </>
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
        <Dato
          label="Plan"
          valor={
            miembro.membresia_tier === 'pro' || miembro.membresia_tier === 'basica' ? (
              <TierBadge pro={miembro.membresia_tier === 'pro'} />
            ) : (
              'Sin plan'
            )
          }
        />
        <Dato
          label="Estado"
          valor={<span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>}
        />
        <Dato label="Inasistencias" valor={String(miembro.no_shows_count ?? 0)} />
        <Dato label="Miembro desde" valor={fechaCorta(miembro.created_at)} />
      </div>

      {/* Acciones de cuenta (Recepción Plus): foto, datos, credenciales. */}
      <section style={{ marginBottom: '20px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>ACCIONES DE CUENTA</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '46px' }} onClick={() => setEditarOpen(true)}>
            <Pencil size={15} aria-hidden="true" /> Editar datos
          </button>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '46px' }} onClick={() => setFotoOpen(true)}>
            <Camera size={15} aria-hidden="true" /> {miembro.avatar_url ? 'Cambiar foto' : 'Tomar foto'}
          </button>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '46px' }} onClick={() => setResetOpen(true)}>
            <KeyRound size={15} aria-hidden="true" /> Resetear acceso
          </button>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ minHeight: '46px' }} onClick={() => setAvisoOpen(true)}>
            <Send size={15} aria-hidden="true" /> Enviar aviso
          </button>
        </div>
      </section>

      {/* Acciones de reserva: crear (RP-3a) + reprogramar/cancelar por fila (RP-3a/3b). */}
      <div style={{ marginBottom: '20px' }}>
        <button
          type="button"
          onClick={() => setCrearOpen(true)}
          disabled={miembro.status !== 'activo'}
          className="ek-cta ek-cta--gold"
          style={{
            minHeight: '46px',
            opacity: miembro.status !== 'activo' ? 0.5 : 1,
            cursor: miembro.status !== 'activo' ? 'not-allowed' : 'pointer'
          }}
        >
          <CalendarPlus size={16} aria-hidden="true" /> Crear reserva
        </button>
        {miembro.status !== 'activo' && (
          <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>
            El miembro no está activo — activá la cuenta en "Editar datos" para poder reservar.
          </p>
        )}
      </div>

      <Seccion titulo="PRÓXIMAS RESERVAS">
        {proximas.length === 0 ? (
          <p className="ek-body-faint">Sin reservas próximas.</p>
        ) : (
          proximas.map((r) => (
            <FilaReserva
              key={r.id}
              reserva={r}
              onCancelar={() =>
                setCancelarTarget({
                  id: r.id,
                  slot_inicio: r.slot_inicio,
                  recurso_nombre: r.recurso?.nombre ?? 'Estudio'
                })
              }
              onReprogramar={() =>
                setReprogramarTarget({
                  id: r.id,
                  recurso_id: r.recurso_id,
                  recurso_nombre: r.recurso?.nombre ?? 'Estudio',
                  slot_inicio: r.slot_inicio,
                  slot_fin: r.slot_fin
                })
              }
              reprogramarBloqueado={miembro.status !== 'activo'}
            />
          ))
        )}
      </Seccion>

      <Seccion titulo={`HISTORIAL (${historial.length})`}>
        {historial.length === 0 ? (
          <p className="ek-body-faint">Sin reservas anteriores.</p>
        ) : (
          historial.slice(0, 15).map((r) => <FilaReserva key={r.id} reserva={r} historico />)
        )}
      </Seccion>

      <section style={{ marginBottom: '20px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>NOTAS OPERATIVAS</p>
        <NotasMiembro miembroId={miembro.id} />
      </section>

      <section style={{ marginBottom: '20px' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '10px' }}>HISTORIAL DE CAMBIOS</p>
        <HistorialCambios entries={auditEntries} isLoading={auditLoading} error={auditError} />
      </section>

      {crearOpen && (
        <CrearReservaModal
          miembro={{
            id: miembro.id,
            nombre: capitalizar(miembro.nombre) || miembro.email,
            membresia_tier: miembro.membresia_tier
          }}
          onClose={() => setCrearOpen(false)}
          onCreada={recargarReservas}
        />
      )}

      {cancelarTarget && (
        <CancelarReservaRecepcionModal
          reserva={cancelarTarget}
          miembroNombre={capitalizar(miembro.nombre) || miembro.email}
          onClose={() => setCancelarTarget(null)}
          onCancelada={recargarReservas}
        />
      )}

      {reprogramarTarget && (
        <CrearReservaModal
          miembro={{
            id: miembro.id,
            nombre: capitalizar(miembro.nombre) || miembro.email,
            membresia_tier: miembro.membresia_tier
          }}
          reprogramarDe={reprogramarTarget}
          onClose={() => setReprogramarTarget(null)}
          onCreada={recargarReservas}
        />
      )}

      {editarOpen && (
        <EditarMiembroModal
          miembro={{
            id: miembro.id,
            nombre: miembro.nombre,
            email: miembro.email,
            telefono: miembro.telefono,
            status: miembro.status,
            membresia_tier: miembro.membresia_tier
          }}
          onClose={() => setEditarOpen(false)}
          onGuardado={recargarPerfil}
        />
      )}

      {fotoOpen && (
        <FotoMiembroModal
          miembroId={miembro.id}
          miembroNombre={capitalizar(miembro.nombre) || miembro.email}
          onClose={() => setFotoOpen(false)}
          onActualizada={recargarPerfil}
        />
      )}

      {resetOpen && (
        <ResetPasswordModal
          miembroId={miembro.id}
          miembroNombre={capitalizar(miembro.nombre) || miembro.email}
          onClose={() => {
            setResetOpen(false);
            void recargarAudit();
          }}
        />
      )}

      {desbloquearOpen && (
        <DesbloquearModal
          miembroId={miembro.id}
          miembroNombre={capitalizar(miembro.nombre) || miembro.email}
          onClose={() => setDesbloquearOpen(false)}
          onDesbloqueado={recargarPerfil}
        />
      )}

      {avisoOpen && (
        <EnviarAvisoModal
          miembroId={miembro.id}
          miembroNombre={capitalizar(miembro.nombre) || miembro.email}
          onClose={() => setAvisoOpen(false)}
        />
      )}
    </div>
  );
}

function iniciales(nombre: string | null, email: string): string {
  const base = (nombre ?? email ?? '?').trim();
  const parts = base.split(/[\s@.]+/).filter(Boolean).slice(0, 2);
  const ini = parts.map((p) => p[0]?.toUpperCase() ?? '').join('');
  return ini || '?';
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

function actorLabel(rol: string | null): string {
  if (rol === 'admin') return 'Admin';
  if (rol === 'recepcionista') return 'Recepción';
  return rol ?? '—';
}

function valorTexto(v: unknown): string {
  if (v == null || v === '') return '—';
  return String(v);
}

function planLabel(v: unknown): string {
  return v == null ? 'sin plan' : String(v);
}

function describirCambio(e: AuditEntryUsuario): string {
  switch (e.accion) {
    case 'status_change':
      return `Cambió estado: ${valorTexto(e.antes?.status)} → ${valorTexto(e.despues?.status)}`;
    case 'tier_change':
      return `Cambió plan: ${planLabel(e.antes?.membresia_tier)} → ${planLabel(e.despues?.membresia_tier)}`;
    case 'unblock':
      return 'Levantó el bloqueo por inasistencia';
    case 'no_show_manual':
      return 'Marcó inasistencia (no-show)';
    case 'checkin_correction':
      return 'Corrigió un check-in';
    case 'contact_change':
      return 'Editó datos de contacto';
    case 'avatar_change':
      return 'Actualizó la foto';
    case 'password_reset':
      return 'Reseteó el acceso';
    case 'create_member':
      return 'Registró al miembro';
    default:
      return e.accion;
  }
}

function HistorialCambios({
  entries,
  isLoading,
  error
}: {
  entries: AuditEntryUsuario[];
  isLoading: boolean;
  error: boolean;
}) {
  if (isLoading) {
    return <div className="ek-skeleton" style={{ height: '48px', borderRadius: 'var(--ek-r-sm)' }} />;
  }
  if (error) {
    return <p className="ek-body-faint">No se pudo cargar el historial.</p>;
  }
  if (entries.length === 0) {
    return <p className="ek-body-faint">Sin cambios registrados.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {entries.map((e) => (
        <div
          key={e.id}
          style={{
            padding: '10px 14px',
            background: 'var(--ek-bg-soft)',
            border: '0.5px solid var(--ek-line)',
            borderRadius: 'var(--ek-r-sm)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: 'var(--ek-ink)', fontWeight: 600 }}>
              {describirCambio(e)}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', whiteSpace: 'nowrap', flexShrink: 0 }}>
              {fechaHora(e.creada_at)}
            </span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '2px' }}>
            {actorLabel(e.actor_rol)}
          </div>
          {e.motivo && (
            <p style={{ fontSize: '12px', color: 'var(--ek-ink-muted)', margin: '6px 0 0', fontStyle: 'italic' }}>
              "{e.motivo}"
            </p>
          )}
        </div>
      ))}
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

function FilaReserva({
  reserva,
  historico,
  onCancelar,
  onReprogramar,
  reprogramarBloqueado
}: {
  reserva: ReservaPerfil;
  historico?: boolean;
  onCancelar?: () => void;
  onReprogramar?: () => void;
  reprogramarBloqueado?: boolean;
}) {
  const cancelada = reserva.status === 'cancelada' || reserva.status === 'cancelada_admin';
  const conAcciones = onCancelar != null || onReprogramar != null;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
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
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: '13px',
          color: 'var(--ek-ink-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {reserva.recurso?.nombre ?? '—'}
      </span>
      {conAcciones ? (
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {onReprogramar && (
            <button
              type="button"
              onClick={onReprogramar}
              disabled={reprogramarBloqueado}
              title={
                reprogramarBloqueado
                  ? 'El miembro no está activo — no se puede reprogramar'
                  : undefined
              }
              style={{
                minHeight: '44px',
                padding: '4px 8px',
                background: 'transparent',
                border: 'none',
                color: reprogramarBloqueado ? 'var(--ek-ink-faint)' : 'var(--ek-mustard)',
                fontSize: '12px',
                fontWeight: 600,
                cursor: reprogramarBloqueado ? 'not-allowed' : 'pointer',
                opacity: reprogramarBloqueado ? 0.5 : 1,
                textDecoration: 'underline',
                textUnderlineOffset: '3px'
              }}
            >
              Reprogramar
            </button>
          )}
          {onCancelar && (
            <button
              type="button"
              onClick={onCancelar}
              style={{
                minHeight: '44px',
                padding: '4px 8px',
                background: 'transparent',
                border: 'none',
                color: 'var(--ek-danger)',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                textDecoration: 'underline',
                textUnderlineOffset: '3px'
              }}
            >
              Cancelar
            </button>
          )}
        </div>
      ) : (
        <span style={{ flexShrink: 0 }}>
          <StatusBadge status={reserva.status} size={11} />
        </span>
      )}
    </div>
  );
}
