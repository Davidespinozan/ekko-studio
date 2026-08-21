import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, UserX, CalendarPlus } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { activarMembresiaMostrador } from '@shared/lib/checkout';
import ConfirmDialog from '@admin/components/ConfirmDialog';
import { EmptyState } from '@shared/components/EmptyState';
import { NotasMiembro } from '@shared/components/NotasMiembro';
import { EnviarAvisoModal } from '@shared/components/EnviarAvisoModal';
import { CrearReservaModal, type ReservaOriginal } from '../components/CrearReservaModal';
import {
  CancelarReservaRecepcionModal,
  type ReservaParaCancelar
} from '../components/CancelarReservaRecepcionModal';
import { EditarMiembroModal } from '../components/EditarMiembroModal';
import { FotoMiembroModal } from '../components/FotoMiembroModal';
import { FichaIdentidadModal } from '../components/FichaIdentidadModal';
import { ResetPasswordModal } from '../components/ResetPasswordModal';
import { DesbloquearModal } from '../components/DesbloquearModal';
import { useAuditLogDeUsuario } from '../hooks/useAuditLogDeUsuario';
import { PerfilHeader } from '../components/perfil/PerfilHeader';
import { EstadoCuentaCard } from '../components/perfil/EstadoCuentaCard';
import { DatosOperativosCard } from '../components/perfil/DatosOperativosCard';
import { AccionesCuenta } from '../components/perfil/AccionesCuenta';
import { FichaIdentidadCard } from '../components/perfil/FichaIdentidadCard';
import { FilaReserva } from '../components/perfil/FilaReserva';
import { HistorialCambios } from '../components/perfil/HistorialCambios';
import { nombreMostrado } from '../components/perfil/perfilUtils';
import type { MiembroPerfil, ReservaPerfil } from '../components/perfil/types';
import { useMembresiaVigente } from '@shared/hooks/useMembresiaVigente';
import { PausarMembresiaModal } from '@shared/components/PausarMembresiaModal';

/**
 * Perfil de miembro para recepción — hub de gestión (agenda, no-show, notas,
 * activar membresía, reprogramar). Orquesta datos + modales; la UI vive en
 * `components/perfil/`. NO reusa `MiembroDetalle` de admin (acciones peligrosas
 * que recepción no debe tener) ni lee campos sensibles (R6).
 */
export default function PerfilMiembroRecepcion() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [activando, setActivando] = useState(false);
  // Saldo de créditos que se perdería si se activa un plan mensual (aviso).
  const [confirmarPerderCreditos, setConfirmarPerderCreditos] = useState<number | null>(null);
  const [miembro, setMiembro] = useState<MiembroPerfil | null>(null);
  const [reservas, setReservas] = useState<ReservaPerfil[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [noEncontrado, setNoEncontrado] = useState(false);
  const [crearOpen, setCrearOpen] = useState(false);
  const [cancelarTarget, setCancelarTarget] = useState<ReservaParaCancelar | null>(null);
  const [reprogramarTarget, setReprogramarTarget] = useState<ReservaOriginal | null>(null);
  const [pausaOpen, setPausaOpen] = useState<null | boolean>(null);
  const { membresia: membresiaViva, refetch: recargarMembresia } = useMembresiaVigente(id);
  const [editarOpen, setEditarOpen] = useState(false);
  const [fotoOpen, setFotoOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [desbloquearOpen, setDesbloquearOpen] = useState(false);
  const [avisoOpen, setAvisoOpen] = useState(false);
  const [fichaOpen, setFichaOpen] = useState(false);
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
      .select('id, slot_inicio, slot_fin, status, folio, recurso_id, invitados_count, recurso:recursos(nombre)')
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
      .select('id, nombre, email, telefono, avatar_url, membresia_tier, status, no_shows_count, bloqueado_hasta, identidad_completa, contrato_firmado, created_at')
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

  // Tras una acción de cuenta: recargar datos del miembro + su historial.
  const recargarPerfil = useCallback(async () => {
    await recargarMiembro();
    await recargarAudit();
  }, [recargarMiembro, recargarAudit]);

  // Activación en mostrador (D4): recepción confirma el pago y activa vía el RPC
  // keystone `activar_membresia` (cierra B3).
  async function activarMembresia() {
    if (!miembro) return;
    if (!miembro.membresia_tier) {
      toast.error('Asigná un plan primero en "Editar datos".');
      return;
    }
    // Aviso: si el miembro tiene créditos y el plan a activar es mensual
    // (ilimitado), esos créditos se perderían. Que sea consciente.
    const [{ data: mem }, { data: tierDestino }] = await Promise.all([
      supabase
        .from('membresias')
        .select('creditos_restantes')
        .eq('usuario_id', miembro.id)
        .in('status', ['trialing', 'activa', 'past_due'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('tiers')
        .select('tipo')
        .eq('slug', miembro.membresia_tier)
        .maybeSingle()
    ]);
    const saldo = mem?.creditos_restantes ?? 0;
    const destinoMensual = tierDestino?.tipo !== 'creditos' && tierDestino?.tipo !== 'hibrido';
    if (saldo > 0 && destinoMensual) {
      setConfirmarPerderCreditos(saldo);
      return;
    }
    await activarConfirmado();
  }

  async function activarConfirmado() {
    if (!miembro?.membresia_tier) return;
    setConfirmarPerderCreditos(null);
    setActivando(true);
    try {
      await activarMembresiaMostrador(miembro.id, miembro.membresia_tier);
      toast.success('Membresía activada.');
      await recargarPerfil();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo activar la membresía.');
    } finally {
      setActivando(false);
    }
  }

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
        <Link to="/recepcion/miembros" className="adm-link" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <ArrowLeft size={15} aria-hidden="true" />
          Volver a búsqueda
        </Link>
        <EmptyState
          icon={UserX}
          title="Miembro no encontrado"
          hint="No pudimos cargar este perfil. Vuelve a la búsqueda e intenta de nuevo."
          tone="danger"
        />
      </div>
    );
  }

  const nombre = nombreMostrado(miembro.nombre, miembro.email);
  const ahora = Date.now();
  const proximas = reservas.filter(
    (r) => r.status === 'confirmada' && new Date(r.slot_inicio).getTime() > ahora
  );
  const historial = reservas.filter((r) => !proximas.includes(r));

  return (
    <div className="rec-main">
      <PerfilHeader miembro={miembro} onFoto={() => setFotoOpen(true)} />

      <EstadoCuentaCard
        miembro={miembro}
        activando={activando}
        onActivar={activarMembresia}
        onDesbloquear={() => setDesbloquearOpen(true)}
      />

      <DatosOperativosCard miembro={miembro} />

      <FichaIdentidadCard
        identidadCompleta={miembro.identidad_completa}
        contratoFirmado={miembro.contrato_firmado}
        onAbrir={() => setFichaOpen(true)}
      />

      <div className="ek-card" style={{ marginBottom: '20px' }}>
        <AccionesCuenta
          tieneFoto={!!miembro.avatar_url}
          onEditar={() => setEditarOpen(true)}
          onFoto={() => setFotoOpen(true)}
          onFicha={() => setFichaOpen(true)}
          onReset={() => setResetOpen(true)}
          onAviso={() => setAvisoOpen(true)}
          onPausar={membresiaViva ? () => setPausaOpen(membresiaViva.status !== 'pausada') : undefined}
          pausada={membresiaViva?.status === 'pausada'}
        />
      </div>

      {pausaOpen !== null && (
        <PausarMembresiaModal
          usuarioId={miembro.id}
          nombre={miembro.nombre}
          pausar={pausaOpen}
          onClose={() => setPausaOpen(null)}
          onDone={async () => {
            await Promise.all([recargarPerfil(), recargarMembresia()]);
          }}
        />
      )}

      {/* Reservas del miembro: crear + próximas + historial, en una card con
          subgrupos (como el admin), no sueltos en el fondo. */}
      <div className="ek-card" style={{ marginBottom: '20px' }}>
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
            El miembro no está activo — activa la cuenta en "Editar datos" para poder reservar.
          </p>
        )}

        <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '18px 0' }} />

        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>PRÓXIMAS RESERVAS</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {proximas.length === 0 ? (
            <p className="ek-body-faint">Sin reservas próximas.</p>
          ) : (
            proximas.map((r) => (
              <FilaReserva
                key={r.id}
                reserva={r}
                onCancelar={() =>
                  setCancelarTarget({ id: r.id, slot_inicio: r.slot_inicio, recurso_nombre: r.recurso?.nombre ?? 'Estudio' })
                }
                onReprogramar={() =>
                  setReprogramarTarget({
                    id: r.id,
                    recurso_id: r.recurso_id,
                    recurso_nombre: r.recurso?.nombre ?? 'Estudio',
                    slot_inicio: r.slot_inicio,
                    slot_fin: r.slot_fin,
                    invitados_count: r.invitados_count ?? 0
                  })
                }
                reprogramarBloqueado={miembro.status !== 'activo'}
              />
            ))
          )}
        </div>

        <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '18px 0' }} />

        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>HISTORIAL ({historial.length})</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {historial.length === 0 ? (
            <p className="ek-body-faint">Sin reservas anteriores.</p>
          ) : (
            historial.slice(0, 15).map((r) => <FilaReserva key={r.id} reserva={r} historico />)
          )}
        </div>
      </div>

      <div className="ek-card" style={{ marginBottom: '20px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>NOTAS DEL MIEMBRO</p>
        <NotasMiembro miembroId={miembro.id} />
      </div>

      <div className="ek-card" style={{ marginBottom: '20px' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>HISTORIAL DE CAMBIOS</p>
        <HistorialCambios entries={auditEntries} isLoading={auditLoading} error={auditError} />
      </div>

      {crearOpen && (
        <CrearReservaModal
          miembro={{ id: miembro.id, nombre, membresia_tier: miembro.membresia_tier }}
          onClose={() => setCrearOpen(false)}
          onCreada={recargarReservas}
        />
      )}

      {cancelarTarget && (
        <CancelarReservaRecepcionModal
          reserva={cancelarTarget}
          miembroNombre={nombre}
          onClose={() => setCancelarTarget(null)}
          onCancelada={recargarReservas}
        />
      )}

      {reprogramarTarget && (
        <CrearReservaModal
          miembro={{ id: miembro.id, nombre, membresia_tier: miembro.membresia_tier }}
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
          miembroNombre={nombre}
          onClose={() => setFotoOpen(false)}
          onActualizada={recargarPerfil}
        />
      )}

      {fichaOpen && (
        <FichaIdentidadModal
          miembroId={miembro.id}
          miembroNombre={nombre}
          tieneFoto={!!miembro.avatar_url}
          onClose={() => setFichaOpen(false)}
          onGuardada={recargarPerfil}
        />
      )}

      {resetOpen && (
        <ResetPasswordModal
          miembroId={miembro.id}
          miembroNombre={nombre}
          onClose={() => {
            setResetOpen(false);
            void recargarAudit();
          }}
        />
      )}

      {desbloquearOpen && (
        <DesbloquearModal
          miembroId={miembro.id}
          miembroNombre={nombre}
          onClose={() => setDesbloquearOpen(false)}
          onDesbloqueado={recargarPerfil}
        />
      )}

      {avisoOpen && (
        <EnviarAvisoModal miembroId={miembro.id} miembroNombre={nombre} onClose={() => setAvisoOpen(false)} />
      )}

      <ConfirmDialog
        isOpen={confirmarPerderCreditos !== null}
        variant="warning"
        title={`Le quedan ${confirmarPerderCreditos ?? 0} ${confirmarPerderCreditos === 1 ? 'crédito' : 'créditos'}`}
        description="El plan a activar es mensual (acceso ilimitado), así que su saldo de créditos se perderá. ¿Activar de todos modos?"
        confirmLabel="Activar igual"
        cancelLabel="Cancelar"
        onConfirm={activarConfirmado}
        onCancel={() => setConfirmarPerderCreditos(null)}
      />
    </div>
  );
}

