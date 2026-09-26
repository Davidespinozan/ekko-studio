import { useParams, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { ArrowLeft, Check, Send, ShieldCheck, ShieldAlert, User } from 'lucide-react';
import { useMiembroDetalle, adminDeleteUser, useMembresiaActualAdmin } from '../hooks/useAdminData';
import { MembresiaCard } from '@reception/components/perfil/MembresiaCard';
import { AsignarPlanModal } from '@shared/components/membresia/AsignarPlanModal';
import { AjustarCreditosModal } from '@shared/components/membresia/AjustarCreditosModal';
import { CancelarMembresiaModal } from '@shared/components/membresia/CancelarMembresiaModal';
import { MaterialReservaModal } from '@shared/components/material/MaterialReservaModal';
import { StatusBadge } from '@shared/components/StatusBadge';
import { formatFechaEnZona } from '@shared/lib/timezone';
import type { AccionMembresia } from '@shared/lib/membresiaAcciones';
import type { MembresiaVigente } from '@shared/hooks/useMembresiaVigente';
import { HistorialPagosMiembro } from '../components/miembro/HistorialPagosMiembro';
import { PausarMembresiaModal } from '@shared/components/PausarMembresiaModal';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { formatHora } from '@member/logic/reservaLogic';
import { Spinner } from '@shared/components/Spinner';
import { EnviarAvisoModal } from '@shared/components/EnviarAvisoModal';
import { FichaIdentidadModal } from '@reception/components/FichaIdentidadModal';
import { HistorialCambios } from '@reception/components/perfil/HistorialCambios';
import { useAuditLogDeUsuario } from '@reception/hooks/useAuditLogDeUsuario';
import { actualizarMiembro } from '@reception/lib/accionesMiembro';
import ConfirmDialog from '../components/ConfirmDialog';
import type { Database } from '@shared/types/database';

export default function MiembroDetalle() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { miembro, reservas, isLoading, refetch } = useMiembroDetalle(id);
  const { membresia, isLoading: membresiaLoading, refetch: refetchMembresia } = useMembresiaActualAdmin(id);
  const { entries: auditEntries, isLoading: auditLoading, error: auditError } = useAuditLogDeUsuario(id);
  const [motivo, setMotivo] = useState('');
  // Modal de membresía abierto (asignar/renovar/cambiar · ajustar créditos · baja).
  const [accionMembresia, setAccionMembresia] = useState<AccionMembresia | null>(null);
  // Sesión cuyo material se está subiendo/entregando.
  const [materialDe, setMaterialDe] = useState<(typeof reservas)[number] | null>(null);
  const [pausaOpen, setPausaOpen] = useState<null | boolean>(null); // true = pausar, false = reanudar
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ status: string }>({ status: '' });
  const [eliminarOpen, setEliminarOpen] = useState(false);
  const [eliminando, setEliminando] = useState(false);
  const [avisoOpen, setAvisoOpen] = useState(false);
  const [fichaOpen, setFichaOpen] = useState(false);

  const totalReservas = reservas.length;

  useEffect(() => {
    if (miembro) {
      setDraft({ status: miembro.status });
    }
  }, [miembro]);

  if (isLoading) return <Spinner label="Cargando…" />;
  if (!miembro) return <p className="adm-body">Miembro no encontrado.</p>;

  const statusCambia = draft.status !== miembro.status;
  const recargarTodo = async () => {
    await Promise.all([refetch(), refetchMembresia()]);
  };

  function abrirAccionMembresia(a: AccionMembresia) {
    if (a === 'pausar') setPausaOpen(true);
    else if (a === 'reanudar') setPausaOpen(false);
    else setAccionMembresia(a);
  }

  // El status de la CUENTA va por el camino gobernado (reception-update-member):
  // exige motivo y deja rastro en "Cambios de cuenta". Antes era un UPDATE directo
  // por RLS: suspender o cancelar a un miembro no quedaba registrado en ningún lado.
  // (El PLAN ya no se edita aquí: se asigna/cambia en la tarjeta de Membresía, que
  // pasa por el RPC keystone `activar_membresia` en un solo paso.)
  async function handleSave() {
    if (motivo.trim().length < 3) {
      setError('Escribe el motivo (mínimo 3 caracteres): queda en el historial de la cuenta.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await actualizarMiembro(miembro!.id, { status: draft.status, motivo: motivo.trim() });
      setMotivo('');
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    }
    setSaving(false);
  }

  async function handleEliminar() {
    if (!miembro) return;
    setEliminando(true);
    const { error: err } = await adminDeleteUser({ usuario_id: miembro.id });
    setEliminando(false);
    if (err) {
      toast.error(err.error || 'No se pudo eliminar el miembro');
      return;
    }
    toast.success(`${miembro.nombre ?? miembro.email} fue eliminado.`);
    setEliminarOpen(false);
    navigate('/admin/miembros');
  }

  return (
    <div className="adm-page">
      <Link
        to="/admin/miembros"
        className="adm-link"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Volver
      </Link>

      {/* Todo lo del miembro en UNA card: identidad editable, ficha e info del
          sistema (los tres son datos del mismo miembro), con divisores finos. */}
      <section className="adm-section" style={{ marginTop: '1rem' }}>
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '2px' }}>MIEMBRO</p>
        <h2 className="ek-h3" style={{ margin: '0 0 18px' }}>Datos del miembro</h2>

        <div style={{ display: 'flex', gap: '22px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <AvatarUploadControl
            usuarioId={miembro.id}
            avatarUrl={miembro.avatar_url}
            onChanged={refetch}
          />
          <div style={{ flex: 1, minWidth: '260px' }}>
            <EditarDatosForm miembro={miembro} onSaved={refetch} />
          </div>
        </div>

        <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '24px 0' }} />

        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>FICHA DE IDENTIDAD</p>
        <p className="adm-body" style={{ marginBottom: '12px', fontSize: '13px' }}>
          Expediente: nacimiento, domicilio, INE (folio y foto) y contrato firmado. Admin ve y edita todo.
        </p>
        <FichaIdentidadResumen
          identidadCompleta={miembro.identidad_completa}
          contratoFirmado={miembro.contrato_firmado}
          onAbrir={() => setFichaOpen(true)}
        />

        <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '24px 0' }} />

        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '12px' }}>INFORMACIÓN DEL SISTEMA</p>
        <div className="adm-info-grid">
          <Info label="Alta" value={new Date(miembro.created_at).toLocaleString('es-MX')} />
          {miembro.commitment_ends_at && (
            <Info label="Commitment hasta" value={new Date(miembro.commitment_ends_at).toLocaleDateString('es-MX')} />
          )}
          {miembro.bloqueado_hasta && new Date(miembro.bloqueado_hasta) > new Date() && (
            <Info label="Bloqueado hasta" value={new Date(miembro.bloqueado_hasta).toLocaleString('es-MX')} />
          )}
          <Info label="No-shows" value={miembro.no_shows_count} />
        </div>
        <ResetPasswordControl email={miembro.email} />
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Membresía</h2>
        {/* La MISMA tarjeta y los mismos modales que recepción: qué se ofrece lo decide
            el estado de la membresía (accionesDeMembresia), y asignar/renovar/cambiar
            es un solo paso. Antes: elegir plan → Guardar con motivo → "Activar
            membresía manualmente" (deshabilitado con "Guarda el plan primero"). */}
        <MembresiaCard
          membresia={membresia as unknown as MembresiaVigente | null}
          cargando={membresiaLoading}
          onAccion={abrirAccionMembresia}
        />

        <h3 className="ek-eyebrow" style={{ margin: '1.25rem 0 0.5rem' }}>CUENTA</h3>
        <div className="adm-form-row">
          <label className="ek-label">
            Status de la cuenta
            <select
              value={draft.status}
              onChange={(e) => setDraft({ status: e.target.value })}
              className="ek-input"
            >
              <option value="pendiente_onboarding">Pendiente de activación</option>
              <option value="pendiente_pago">Pendiente de pago</option>
              <option value="activo">Activo</option>
              <option value="suspendido">Suspendido (no entra ni reserva)</option>
              <option value="cancelado">Cancelado (puede volver a comprar)</option>
            </select>
          </label>
          {statusCambia && (
            <label className="ek-label">
              Motivo del cambio
              <input
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                className="ek-input"
                placeholder="Ej. Daño al equipo · A petición del miembro"
              />
            </label>
          )}
        </div>
        <p className="adm-body" style={{ marginTop: '0.75rem', fontSize: '13px' }}>
          El status de la cuenta decide si la persona puede ENTRAR. El plan, su vigencia y sus créditos se
          gestionan arriba, en Membresía. Para una ausencia temporal usa "Pausar", no "Suspendido".
        </p>
        {error && <p className="ek-error-text">{error}</p>}
        {statusCambia && (
          <div style={{ marginTop: '1rem' }}>
            <button onClick={handleSave} disabled={saving} className="ek-cta">
              {saving ? 'Guardando…' : 'Guardar status'}
            </button>
          </div>
        )}
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Cobros</h2>
        <p className="adm-body" style={{ marginBottom: '0.75rem', fontSize: '13px' }}>
          Lo que Stripe cobró (o rechazó) a este miembro. Los pagos en mostrador no pasan por aquí.
        </p>
        <HistorialPagosMiembro usuarioId={miembro.id} />
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Nota para el check-in</h2>
        <p className="adm-body" style={{ marginBottom: '0.5rem' }}>
          Recepción la ve cuando el miembro llega a su sesión. Útil para
          preferencias, equipo solicitado u observaciones importantes.
        </p>
        <NotasControl
          usuarioId={miembro.id}
          notasIniciales={(miembro as { notas_admin?: string | null }).notas_admin ?? null}
          onSaved={refetch}
        />
      </section>

      <section className="adm-section">
        <h2 className="ek-h3">Avisar al miembro</h2>
        <p className="adm-body" style={{ marginBottom: '0.75rem' }}>
          Manda un aviso in-app puntual. El miembro lo verá en sus notificaciones.
        </p>
        <button onClick={() => setAvisoOpen(true)} className="ek-cta ek-cta--secondary" style={{ minHeight: '44px' }}>
          <Send size={15} aria-hidden="true" /> Enviar aviso
        </button>
      </section>

      {/* Historial del miembro: reservas (actividad) + cambios de cuenta
          (auditoría). Son datos distintos, pero ambos son "el historial" → un
          solo bloque con subgrupos, en vez de dos cards separadas por la zona
          peligrosa. */}
      <section className="adm-section">
        <h2 className="ek-h3" style={{ marginBottom: '18px' }}>Historial del miembro</h2>

        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>
          RESERVAS ({reservas.length})
        </p>
        {reservas.length === 0 ? (
          <p className="adm-body">Sin reservas.</p>
        ) : (
          <div className="adm-table-wrapper">
            <table className="adm-table">
              <thead>
                <tr><th>Folio</th><th>Fecha</th><th>Estudio</th><th>Status</th><th>Material</th></tr>
              </thead>
              <tbody>
                {reservas.map((r) => (
                  <tr key={r.id}>
                    <td><code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.folio}</code></td>
                    <td>
                      {formatFechaEnZona(r.slot_inicio, { day: 'numeric', month: 'short', year: 'numeric' })}
                      {' · '}
                      {formatHora(new Date(r.slot_inicio))}
                    </td>
                    <td>{r.recurso?.nombre ?? '—'}</td>
                    <td><StatusBadge status={r.status} size={11} /></td>
                    <td>
                      {r.status !== 'cancelada' && r.status !== 'cancelada_admin' && (
                        <button type="button" className="adm-link" onClick={() => setMaterialDe(r)}>
                          Material
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ height: '0.5px', background: 'var(--ek-line)', margin: '24px 0' }} />

        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '4px' }}>CAMBIOS DE CUENTA</p>
        <p className="adm-body" style={{ marginBottom: '12px', fontSize: '13px' }}>
          Auditoría de acciones sensibles sobre el miembro (status, plan, identidad…).
        </p>
        <HistorialCambios entries={auditEntries} isLoading={auditLoading} error={auditError} />
      </section>

      <section
        className="adm-section"
        style={{ borderTop: '0.5px solid var(--ek-danger)', paddingTop: '20px', marginTop: '32px' }}
      >
        <p className="ek-eyebrow" style={{ color: 'var(--ek-danger)', marginBottom: '6px' }}>
          ZONA PELIGROSA
        </p>
        <h2 className="ek-h3">Eliminar miembro</h2>
        <p className="adm-body" style={{ marginBottom: '12px' }}>
          <strong>Hard delete</strong>: borra la cuenta de Auth y los datos del miembro de la BD.
          Libera el email para que pueda volver a ser invitado.
          Acción <strong style={{ color: 'var(--ek-danger)' }}>irreversible</strong>.
          {totalReservas > 0 && (
            <>
              {' '}
              <strong style={{ color: 'var(--ek-danger)' }}>
                Tiene {totalReservas} {totalReservas === 1 ? 'reserva en historial' : 'reservas en historial'}
              </strong>
              {' '}— el sistema bloqueará la eliminación para preservar auditoría.
              Cambia el status a <code style={{ fontFamily: 'var(--ek-font-mono)' }}>cancelado</code> si solo quieres darlo de baja.
            </>
          )}
        </p>
        <button
          onClick={() => setEliminarOpen(true)}
          className="ek-cta"
          style={{
            background: 'var(--ek-danger-soft)',
            color: 'var(--ek-danger)',
            border: '0.5px solid var(--ek-danger)'
          }}
        >
          Eliminar definitivamente
        </button>
      </section>

      {avisoOpen && (
        <EnviarAvisoModal
          miembroId={miembro.id}
          miembroNombre={miembro.nombre ?? miembro.email}
          onClose={() => setAvisoOpen(false)}
        />
      )}

      {fichaOpen && (
        <FichaIdentidadModal
          miembroId={miembro.id}
          miembroNombre={miembro.nombre ?? miembro.email}
          tieneFoto={!!miembro.avatar_url}
          onClose={() => setFichaOpen(false)}
          onGuardada={() => { void refetch(); }}
        />
      )}

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
          planActualSlug={membresia?.tier?.slug ?? null}
          onClose={() => setAccionMembresia(null)}
          onDone={recargarTodo}
        />
      )}
      {accionMembresia === 'ajustar_creditos' && membresia && (
        <AjustarCreditosModal
          usuarioId={miembro.id}
          nombre={miembro.nombre}
          saldoActual={membresia.creditos_restantes ?? 0}
          onClose={() => setAccionMembresia(null)}
          onDone={recargarTodo}
        />
      )}
      {accionMembresia === 'dar_de_baja' && membresia && (
        <CancelarMembresiaModal
          usuarioId={miembro.id}
          nombre={miembro.nombre}
          conSuscripcion={Boolean(membresia.stripe_subscription_id)}
          enPausa={membresia.status === 'pausada'}
          periodoFin={membresia.periodo_actual_fin}
          creditos={membresia.creditos_restantes}
          onClose={() => setAccionMembresia(null)}
          onDone={recargarTodo}
        />
      )}
      {materialDe && (
        <MaterialReservaModal
          reserva={{
            id: materialDe.id,
            usuario_id: miembro.id,
            slot_inicio: materialDe.slot_inicio,
            folio: materialDe.folio ?? null,
            recurso_nombre: materialDe.recurso?.nombre ?? 'Estudio'
          }}
          miembroNombre={miembro.nombre ?? miembro.email}
          onClose={() => setMaterialDe(null)}
        />
      )}
      <ConfirmDialog
        isOpen={eliminarOpen}
        title={`¿Eliminar a ${miembro.nombre ?? miembro.email}?`}
        description={`Esta acción borra la cuenta de Auth y todos los datos del miembro de la BD (notificaciones, membresías). El email queda libre para volver a invitarse. ${totalReservas > 0 ? `Atención: tiene ${totalReservas} ${totalReservas === 1 ? 'reserva' : 'reservas'} en historial — el backend va a bloquear la operación. ` : ''}Escribe ELIMINAR para confirmar.`}
        confirmLabel={eliminando ? 'Eliminando…' : 'Eliminar definitivamente'}
        variant="danger"
        requireTypedConfirmation="ELIMINAR"
        onConfirm={handleEliminar}
        onCancel={() => setEliminarOpen(false)}
      />
    </div>
  );
}

function FichaIdentidadResumen({ identidadCompleta, contratoFirmado, onAbrir }: {
  identidadCompleta: boolean;
  contratoFirmado: boolean;
  onAbrir: () => void;
}) {
  const completa = identidadCompleta && contratoFirmado;
  const falta = [!identidadCompleta && 'datos/foto/INE', !contratoFirmado && 'contrato firmado']
    .filter(Boolean)
    .join(' y ');
  return (
    <div
      className="ek-card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        borderColor: completa ? undefined : 'var(--ek-warning)',
        background: completa ? undefined : 'var(--ek-warning-soft)'
      }}
    >
      {completa ? (
        <ShieldCheck size={22} style={{ color: 'var(--ek-success)', flexShrink: 0 }} aria-hidden="true" />
      ) : (
        <ShieldAlert size={22} style={{ color: 'var(--ek-warning)', flexShrink: 0 }} aria-hidden="true" />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: '14px' }}>
          {completa ? 'Ficha completa' : 'Ficha incompleta'}
        </p>
        <p className="ek-body-muted" style={{ margin: '2px 0 0', fontSize: '12.5px' }}>
          {completa ? 'Identidad y contrato en orden.' : `Falta: ${falta}.`}
        </p>
      </div>
      <button
        type="button"
        className={completa ? 'ek-cta ek-cta--secondary' : 'ek-cta ek-cta--gold'}
        style={{ padding: '9px 16px', fontSize: '13px', flexShrink: 0 }}
        onClick={onAbrir}
      >
        {completa ? 'Ver ficha' : 'Completar ficha'}
      </button>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="adm-info-label">{label}</p>
      <p className="adm-info-value" style={mono ? { fontFamily: 'var(--ek-font-mono)' } : undefined}>
        {value}
      </p>
    </div>
  );
}

function AvatarUploadControl({ usuarioId, avatarUrl, onChanged }: {
  usuarioId: string;
  avatarUrl: string | null;
  onChanged: () => Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const path = `${usuarioId}/${Date.now()}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from('avatars')
        .upload(path, file, { cacheControl: '3600', upsert: false });

      if (uploadErr) throw uploadErr;

      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);

      const { error: updateErr } = await supabase
        .from('usuarios')
        .update({ avatar_url: publicUrl })
        .eq('id', usuarioId);

      if (updateErr) throw updateErr;

      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error subiendo foto');
    }
    setUploading(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="Foto del miembro" style={{
          width: '88px', height: '88px', borderRadius: '50%', objectFit: 'cover',
          border: '1px solid var(--ek-line)'
        }} />
      ) : (
        <div style={{
          width: '88px', height: '88px', borderRadius: '50%',
          background: 'var(--ek-bg-elevated)',
          border: '2px dashed var(--ek-line-strong)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--ek-ink-faint)'
        }}>
          <User size={30} strokeWidth={1.5} aria-hidden="true" />
        </div>
      )}
      <label style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: 'var(--ek-mustard)' }}>
        {uploading ? 'Subiendo…' : avatarUrl ? 'Cambiar foto' : 'Subir foto'}
        <input
          type="file"
          accept="image/*"
          disabled={uploading}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          style={{ display: 'none' }}
        />
      </label>
      {error && <p className="ek-error-text" style={{ fontSize: '11px', margin: 0 }}>{error}</p>}
    </div>
  );
}

function EditarDatosForm({ miembro, onSaved }: {
  miembro: Database['public']['Tables']['usuarios']['Row'];
  onSaved: () => Promise<void>;
}) {
  const [nombre, setNombre] = useState(miembro.nombre ?? '');
  const [telefono, setTelefono] = useState(miembro.telefono ?? '');
  const [email, setEmail] = useState(miembro.email ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailCambio = email.trim().toLowerCase() !== (miembro.email ?? '').toLowerCase();
  const isDirty =
    nombre !== (miembro.nombre ?? '') || telefono !== (miembro.telefono ?? '') || emailCambio;

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // reception-update-member (autoriza admin): nombre/teléfono en usuarios y
      // el email también en Auth (es la identidad de login). Queda en audit_log.
      const res = await actualizarMiembro(miembro.id, {
        nombre: nombre.trim(),
        telefono: telefono.trim(),
        email: email.trim()
      });
      if (!res.success && !res.sin_cambios) throw new Error('No se pudo guardar');
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error guardando');
    }
    setSaving(false);
  }

  return (
    <div className="adm-info-grid" style={{ background: 'transparent', padding: 0, border: 'none' }}>
      <label className="ek-label">
        Nombre
        <input
          type="text"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          className="ek-input"
          placeholder="Nombre completo"
        />
      </label>
      <label className="ek-label">
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="ek-input"
          placeholder="correo@ejemplo.com"
        />
      </label>
      <label className="ek-label">
        Teléfono
        <input
          type="tel"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          className="ek-input"
          placeholder="+52 667 123 4567"
        />
      </label>
      {emailCambio && (
        <p className="adm-body" style={{ gridColumn: '1 / -1', fontSize: '12px', color: 'var(--ek-warning)', margin: 0 }}>
          Cambiar el email también cambia el correo con el que el miembro inicia sesión.
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.75rem', gridColumn: '1 / -1' }}>
        <button
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="ek-cta"
        >
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>
        {saved && (
          <span style={{ color: 'var(--ek-success)', fontSize: '0.875rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <Check size={14} aria-hidden="true" />
            Guardado
          </span>
        )}
        {error && <span style={{ color: 'var(--ek-danger)', fontSize: '0.875rem' }}>{error}</span>}
      </div>
    </div>
  );
}

function ResetPasswordControl({ email }: { email: string }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    if (!confirm(`¿Enviar email de recuperación de contraseña a ${email}?`)) return;
    setSending(true);
    setError(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/nueva-contrasena`
      });
      if (error) throw error;
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error enviando');
    }
    setSending(false);
  }

  if (sent) {
    return (
      <p style={{ marginTop: '1rem', fontSize: '0.875rem', color: 'var(--ek-success)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Check size={15} aria-hidden="true" />
        Email de recuperación enviado a {email}
      </p>
    );
  }

  return (
    <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
      <button onClick={handleReset} disabled={sending} className="ek-cta ek-cta--secondary">
        {sending ? 'Enviando…' : 'Enviar email de recuperación de contraseña'}
      </button>
      {error && <span style={{ color: 'var(--ek-danger)', fontSize: '0.875rem' }}>{error}</span>}
    </div>
  );
}

function NotasControl({ usuarioId, notasIniciales, onSaved }: {
  usuarioId: string;
  notasIniciales: string | null;
  onSaved: () => Promise<void>;
}) {
  const [notas, setNotas] = useState(notasIniciales ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { error } = await supabase
        .from('usuarios')
        .update({ notas_admin: notas.trim() || null } as never)
        .eq('id', usuarioId);
      if (error) throw error;
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error guardando');
    }
    setSaving(false);
  }

  return (
    <div className="ek-stack-md">
      <textarea
        value={notas}
        onChange={(e) => setNotas(e.target.value)}
        maxLength={500}
        rows={4}
        placeholder="Ej. Suele grabar podcasts largos. Prefiere micrófono Shure. Acompañado de 1 editor."
        className="ek-input"
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p style={{ fontSize: '0.75rem', color: 'var(--ek-ink-muted)' }}>
          {notas.length}/500 caracteres
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {saved && (
          <span style={{ color: 'var(--ek-success)', fontSize: '0.875rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <Check size={14} aria-hidden="true" />
            Guardado
          </span>
        )}
          {error && <span style={{ color: 'var(--ek-danger)', fontSize: '0.875rem' }}>{error}</span>}
          <button onClick={handleSave} disabled={saving} className="ek-cta">
            {saving ? 'Guardando…' : 'Guardar notas'}
          </button>
        </div>
      </div>
    </div>
  );
}
