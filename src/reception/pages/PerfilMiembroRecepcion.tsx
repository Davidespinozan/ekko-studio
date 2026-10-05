import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, UserX, CalendarPlus } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { EmptyState } from '@shared/components/EmptyState';
import { ErrorInline } from '@shared/components/ErrorCarga';
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
import { MembresiaCard } from '../components/perfil/MembresiaCard';
import { DatosOperativosCard } from '../components/perfil/DatosOperativosCard';
import { AccionesCuenta } from '../components/perfil/AccionesCuenta';
import { FichaIdentidadCard } from '../components/perfil/FichaIdentidadCard';
import { FilaReserva } from '../components/perfil/FilaReserva';
import { HistorialCambios } from '../components/perfil/HistorialCambios';
import { nombreMostrado } from '../components/perfil/perfilUtils';
import type { MiembroPerfil, ReservaPerfil } from '../components/perfil/types';
import { useMembresiaVigente } from '@shared/hooks/useMembresiaVigente';
import { PausarMembresiaModal } from '@shared/components/PausarMembresiaModal';
import { AsignarPlanModal } from '@shared/components/membresia/AsignarPlanModal';
import { AjustarCreditosModal } from '@shared/components/membresia/AjustarCreditosModal';
import { CancelarMembresiaModal } from '@shared/components/membresia/CancelarMembresiaModal';
import type { AccionMembresia } from '@shared/lib/membresiaAcciones';
import { MaterialReservaModal } from '@shared/components/material/MaterialReservaModal';
import { marcarMaterialRequerido } from '@shared/lib/material';
import { useToast } from '@shared/hooks/useToast';

/**
 * Perfil de miembro para recepción — hub de gestión (agenda, no-show, notas,
 * membresía, reprogramar). Orquesta datos + modales; la UI vive en
 * `components/perfil/`.
 *
 * La membresía se carga UNA vez aquí (`useMembresiaVigente`) y baja a todas las
 * tarjetas; tras cualquier acción `recargarTodo` refresca miembro + membresía +
 * reservas + historial juntos. Antes cada tarjeta consultaba por su cuenta y la
 * ficha quedaba vieja: recepción creía que la acción había fallado y la repetía. NO reusa `MiembroDetalle` de admin (acciones peligrosas
 * que recepción no debe tener) ni lee campos sensibles (R6).
 */
export default function PerfilMiembroRecepcion() {
  const { id } = useParams<{ id: string }>();
  // Modal de membresía abierto (asignar/renovar/cambiar · ajustar créditos · baja).
  const [accionMembresia, setAccionMembresia] = useState<AccionMembresia | null>(null);
  // Sesión cuyo material se está subiendo/entregando.
  const [materialDe, setMaterialDe] = useState<ReservaPerfil | null>(null);
  const [guardandoMaterialDe, setGuardandoMaterialDe] = useState<string | null>(null);
  const toast = useToast();
  const [miembro, setMiembro] = useState<MiembroPerfil | null>(null);
  const [reservas, setReservas] = useState<ReservaPerfil[]>([]);
  // PKG-02A (C02 · F19): fallo leyendo reservas ≠ "sin reservas". Estado propio,
  // independiente del de la membresía (F03).
  const [errorReservas, setErrorReservas] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [noEncontrado, setNoEncontrado] = useState(false);
  const [crearOpen, setCrearOpen] = useState(false);
  const [cancelarTarget, setCancelarTarget] = useState<ReservaParaCancelar | null>(null);
  const [reprogramarTarget, setReprogramarTarget] = useState<ReservaOriginal | null>(null);
  const [pausaOpen, setPausaOpen] = useState<null | boolean>(null);
  const { membresia: membresiaViva, isLoading: membresiaCargando, error: membresiaError, refetch: recargarMembresia } = useMembresiaVigente(id);
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
    const { data, error } = await supabase
      .from('reservas')
      .select('id, slot_inicio, slot_fin, status, folio, recurso_id, invitados_count, material_requerido, recurso:recursos(nombre)')
      .eq('usuario_id', id)
      .order('slot_inicio', { ascending: false })
      .limit(50);
    if (error) {
      console.error('[PerfilMiembroRecepcion] reservas', error);
      setErrorReservas(true); // las reservas anteriores se conservan
      return;
    }
    setErrorReservas(false);
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

  // Tras una acción sobre la MEMBRESÍA cambia todo a la vez: plan y status de la
  // cuenta, vigencia/créditos, historial de cambios y (baja/cambio) las reservas.
  const recargarTodo = useCallback(async () => {
    await Promise.all([recargarMiembro(), recargarMembresia(), recargarAudit(), recargarReservas()]);
  }, [recargarMiembro, recargarMembresia, recargarAudit, recargarReservas]);

  function abrirAccionMembresia(a: AccionMembresia) {
    if (a === 'pausar') setPausaOpen(true);
    else if (a === 'reanudar') setPausaOpen(false);
    else setAccionMembresia(a);
  }

  async function toggleMaterialRequerido(r: ReservaPerfil) {
    setGuardandoMaterialDe(r.id);
    try {
      await marcarMaterialRequerido(r.id, !r.material_requerido);
      await recargarReservas();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setGuardandoMaterialDe(null);
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

      <MembresiaCard
        membresia={membresiaViva}
        cargando={membresiaCargando}
        error={membresiaError}
        onReintentar={() => void recargarMembresia()}
        onAccion={abrirAccionMembresia}
      />

      <EstadoCuentaCard
        miembro={miembro}
        enPausa={membresiaViva?.status === 'pausada'}
        onDesbloquear={() => setDesbloquearOpen(true)}
      />

      <DatosOperativosCard miembro={miembro} membresia={membresiaViva} />

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
        />
      </div>

      {pausaOpen !== null && (
        <PausarMembresiaModal
          usuarioId={miembro.id}
          nombre={miembro.nombre}
          pausar={pausaOpen}
          onClose={() => setPausaOpen(null)}
          onDone={recargarTodo}
        />
      )}

      {(accionMembresia === 'asignar' || accionMembresia === 'renovar' || accionMembresia === 'cambiar') && (
        <AsignarPlanModal
          usuarioId={miembro.id}
          nombre={miembro.nombre}
          modo={accionMembresia}
          planActualSlug={membresiaViva?.tier?.slug ?? null}
          onClose={() => setAccionMembresia(null)}
          onDone={recargarTodo}
        />
      )}

      {accionMembresia === 'ajustar_creditos' && membresiaViva && (
        <AjustarCreditosModal
          usuarioId={miembro.id}
          nombre={miembro.nombre}
          saldoActual={membresiaViva.creditos_restantes ?? 0}
          onClose={() => setAccionMembresia(null)}
          onDone={recargarTodo}
        />
      )}

      {accionMembresia === 'dar_de_baja' && membresiaViva && (
        <CancelarMembresiaModal
          usuarioId={miembro.id}
          nombre={miembro.nombre}
          conSuscripcion={Boolean(membresiaViva.stripe_subscription_id)}
          enPausa={membresiaViva.status === 'pausada'}
          periodoFin={membresiaViva.periodo_actual_fin}
          creditos={membresiaViva.creditos_restantes}
          onClose={() => setAccionMembresia(null)}
          onDone={recargarTodo}
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
            La cuenta no está activa — revisa la tarjeta de Membresía arriba.
          </p>
        )}

        <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '18px 0' }} />

        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>PRÓXIMAS RESERVAS</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* PKG-02A (F19): error sin dato → aviso (no "Sin reservas"); error con dato previo → lista + aviso stale. */}
          {errorReservas && (
            <ErrorInline
              mensaje={reservas.length === 0 ? 'No pudimos cargar las reservas del miembro.' : 'No pudimos actualizar las reservas; ves la última versión cargada.'}
              onReintentar={() => void recargarReservas()}
            />
          )}
          {!errorReservas && proximas.length === 0 ? (
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
          {errorReservas && reservas.length === 0 ? (
            <p className="ek-body-faint">Historial no disponible.</p>
          ) : historial.length === 0 ? (
            <p className="ek-body-faint">Sin reservas anteriores.</p>
          ) : (
            historial.slice(0, 15).map((r) => (
              <FilaReserva
                key={r.id}
                reserva={r}
                historico
                onMaterial={() => setMaterialDe(r)}
                onToggleMaterialRequerido={() => void toggleMaterialRequerido(r)}
                guardandoMaterialRequerido={guardandoMaterialDe === r.id}
              />
            ))
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

      {materialDe && (
        <MaterialReservaModal
          reserva={{
            id: materialDe.id,
            usuario_id: miembro.id,
            slot_inicio: materialDe.slot_inicio,
            folio: materialDe.folio ?? null,
            recurso_nombre: materialDe.recurso?.nombre ?? 'Estudio'
          }}
          miembroNombre={nombre}
          onClose={() => {
            setMaterialDe(null);
            void recargarAudit();
          }}
        />
      )}

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
            telefono: miembro.telefono
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

    </div>
  );
}

