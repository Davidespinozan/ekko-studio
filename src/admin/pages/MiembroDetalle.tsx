import { useParams, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { ArrowLeft, Check, Send, ShieldCheck, ShieldAlert, User } from 'lucide-react';
import { useMiembroDetalle, updateMiembro, adminDeleteUser, useTiersAdmin, useMembresiaActualAdmin } from '../hooks/useAdminData';
import { activarMembresiaMostrador } from '@shared/lib/checkout';
import { MembresiaActualCard } from '../components/miembro/MembresiaActualCard';
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
  const { tiers } = useTiersAdmin();
  const { membresia, isLoading: membresiaLoading, refetch: refetchMembresia } = useMembresiaActualAdmin(id);
  const { entries: auditEntries, isLoading: auditLoading, error: auditError } = useAuditLogDeUsuario(id);
  const [motivo, setMotivo] = useState('');
  const [activando, setActivando] = useState(false);
  const [confirmarPerderCreditos, setConfirmarPerderCreditos] = useState<number | null>(null);
  const [pausaOpen, setPausaOpen] = useState<null | boolean>(null); // true = pausar, false = reanudar
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ status: string; membresia_tier: string }>({
    status: '',
    membresia_tier: ''
  });
  const [eliminarOpen, setEliminarOpen] = useState(false);
  const [eliminando, setEliminando] = useState(false);
  const [avisoOpen, setAvisoOpen] = useState(false);
  const [fichaOpen, setFichaOpen] = useState(false);

  const totalReservas = reservas.length;

  useEffect(() => {
    if (miembro) {
      setDraft({ status: miembro.status, membresia_tier: miembro.membresia_tier ?? '' });
    }
  }, [miembro]);

  if (isLoading) return <Spinner label="Cargando…" />;
  if (!miembro) return <p className="adm-body">Miembro no encontrado.</p>;

  const tierCambia = (draft.membresia_tier || null) !== (miembro.membresia_tier ?? null);
  const statusCambia = draft.status !== miembro.status;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      // El plan asignado va por el camino GOBERNADO (reception-update-member):
      // valida el tier contra los planes del estudio, exige motivo y audita.
      // Antes se escribía usuarios.membresia_tier directo desde el navegador y
      // la ficha divergía de recepción/reportes (B3).
      if (tierCambia) {
        if (motivo.trim().length < 3) {
          setError('Escribe un motivo (mínimo 3 caracteres) para cambiar el plan.');
          setSaving(false);
          return;
        }
        await actualizarMiembro(miembro!.id, { membresia_tier: draft.membresia_tier || null, motivo: motivo.trim() });
      }
      if (statusCambia) {
        const { error: err } = await updateMiembro(miembro!.id, { status: draft.status as any });
        if (err) throw new Error(err);
      }
      setMotivo('');
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    }
    setSaving(false);
  }

  // Activación manual (cortesía, transferencia, pago en mostrador): el MISMO RPC
  // keystone que recepción y el webhook (activar_membresia). Avisa si se
  // perderían créditos al pasar a un plan mensual.
  async function activarMembresia() {
    if (!miembro?.membresia_tier) {
      setError('Asigna un plan (y guarda) antes de activar la membresía.');
      return;
    }
    const saldo = membresia?.creditos_restantes ?? 0;
    const destino = tiers.find((t) => t.slug === miembro.membresia_tier);
    const destinoMensual = destino?.tipo !== 'creditos' && destino?.tipo !== 'hibrido';
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
    setError(null);
    try {
      await activarMembresiaMostrador(miembro.id, miembro.membresia_tier);
      toast.success('Membresía activada.');
      await Promise.all([refetch(), refetchMembresia()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo activar la membresía.');
    } finally {
      setActivando(false);
    }
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
        <MembresiaActualCard membresia={membresia} isLoading={membresiaLoading} planAsignado={miembro.membresia_tier ?? null} />
        <div className="adm-form-row" style={{ marginTop: '1rem' }}>
          <label className="ek-label">
            Status de la cuenta
            <select
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}
              className="ek-input"
            >
              <option value="pendiente_onboarding">pendiente_onboarding</option>
              <option value="pendiente_pago">pendiente_pago</option>
              <option value="activo">activo</option>
              <option value="suspendido">suspendido</option>
              <option value="cancelado">cancelado</option>
            </select>
          </label>
          <label className="ek-label">
            Plan asignado
            <select
              value={draft.membresia_tier}
              onChange={(e) => setDraft((d) => ({ ...d, membresia_tier: e.target.value }))}
              className="ek-input"
            >
              <option value="">— sin plan —</option>
              {/* Solo planes ACTIVOS: no se puede asignar uno eliminado. */}
              {tiers.filter((t) => t.activo).map((t) => (
                <option key={t.id} value={t.slug}>{t.nombre}</option>
              ))}
              {draft.membresia_tier && !tiers.some((t) => t.activo && t.slug === draft.membresia_tier) && (
                <option value={draft.membresia_tier}>
                  {(tiers.find((t) => t.slug === draft.membresia_tier)?.nombre ?? draft.membresia_tier)} (eliminado)
                </option>
              )}
            </select>
          </label>
        </div>
        {tierCambia && (
          <label className="ek-label" style={{ display: 'block', marginTop: '0.75rem' }}>
            Motivo del cambio de plan
            <input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              className="ek-input"
              placeholder="Ej. Cambió a Premium, pagó en mostrador"
            />
          </label>
        )}
        <p className="adm-body" style={{ marginTop: '0.75rem', fontSize: '13px' }}>
          "Plan asignado" es el plan que el miembro debe pagar; la membresía queda <strong>vigente</strong> cuando
          paga en la app (Stripe) o cuando la activas aquí manualmente (cortesía, transferencia, mostrador).
        </p>
        {error && <p className="ek-error-text">{error}</p>}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '1rem' }}>
          <button onClick={handleSave} disabled={saving || (!tierCambia && !statusCambia)} className="ek-cta">
            {saving ? 'Guardando…' : 'Guardar cambios'}
          </button>
          <button
            onClick={activarMembresia}
            disabled={activando || tierCambia || !miembro.membresia_tier}
            className="ek-cta ek-cta--secondary"
            title={tierCambia ? 'Guarda el plan primero' : undefined}
          >
            {activando ? 'Activando…' : 'Activar membresía manualmente'}
          </button>
          {membresia && membresia.status !== 'pausada' && (
            <button onClick={() => setPausaOpen(true)} className="ek-cta ek-cta--secondary">
              Pausar membresía
            </button>
          )}
          {membresia && membresia.status === 'pausada' && (
            <button onClick={() => setPausaOpen(false)} className="ek-cta ek-cta--secondary">
              Reanudar membresía
            </button>
          )}
        </div>
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
                <tr><th>Folio</th><th>Fecha</th><th>Estudio</th><th>Status</th></tr>
              </thead>
              <tbody>
                {reservas.map((r) => (
                  <tr key={r.id}>
                    <td><code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.folio}</code></td>
                    <td>
                      {new Date(r.slot_inicio).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' })}
                      {' · '}
                      {formatHora(new Date(r.slot_inicio))}
                    </td>
                    <td>{r.recurso?.nombre ?? '—'}</td>
                    <td><code style={{ fontFamily: 'var(--ek-font-mono)' }}>{r.status}</code></td>
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
          onDone={async () => {
            await Promise.all([refetch(), refetchMembresia()]);
          }}
        />
      )}
      <ConfirmDialog
        isOpen={confirmarPerderCreditos !== null}
        title="El miembro perdería sus créditos"
        description={`Tiene ${confirmarPerderCreditos ?? 0} crédito(s) vigentes. Al activar un plan mensual, ese saldo se pierde. ¿Activar de todos modos?`}
        confirmLabel="Activar y perder créditos"
        variant="danger"
        onConfirm={activarConfirmado}
        onCancel={() => setConfirmarPerderCreditos(null)}
      />
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
