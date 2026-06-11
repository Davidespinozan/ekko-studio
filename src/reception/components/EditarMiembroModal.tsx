import { useState, FormEvent } from 'react';
import { X } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { actualizarMiembro } from '../lib/accionesMiembro';
import { MotivoField } from './MotivoField';

export interface MiembroEditable {
  id: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
  status: string;
  membresia_tier: string | null;
}

interface Props {
  miembro: MiembroEditable;
  onClose: () => void;
  onGuardado: () => void;
}

const STATUS_OPCIONES = [
  { value: 'activo', label: 'Activo' },
  { value: 'suspendido', label: 'Suspendido' },
  { value: 'pendiente_pago', label: 'Pendiente de pago' }
];

const TIER_OPCIONES = [
  { value: '', label: 'Sin plan' },
  { value: 'basica', label: 'Básica' },
  { value: 'pro', label: 'Pro' }
];

// Motivos predefinidos para los cambios sensibles (Bloque A — gobernanza).
const MOTIVOS_STATUS = [
  'Cliente activó/pagó plan',
  'Cliente solicitó suspensión',
  'No-show acumulado / cuenta de riesgo',
  'Cuenta dada de baja por el cliente'
];
const MOTIVOS_TIER = [
  'Cliente subió de plan',
  'Cliente bajó de plan',
  'Promoción / cortesía'
];

/**
 * Edición de la cuenta del miembro desde recepción: contacto + status + plan.
 * El email también cambia la cuenta de acceso (auth). Los cambios sensibles
 * (status/plan) exigen motivo y quedan registrados en audit_log (Bloque A).
 */
export function EditarMiembroModal({ miembro, onClose, onGuardado }: Props) {
  const toast = useToast();
  const [nombre, setNombre] = useState(miembro.nombre ?? '');
  const [email, setEmail] = useState(miembro.email);
  const [telefono, setTelefono] = useState(miembro.telefono ?? '');
  const [status, setStatus] = useState(miembro.status);
  const [tier, setTier] = useState(miembro.membresia_tier ?? '');
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  const emailCambia = email.trim().toLowerCase() !== miembro.email.toLowerCase();
  const statusCambia = status !== miembro.status;
  const tierCambia = (tier === '' ? null : tier) !== (miembro.membresia_tier ?? null);
  const requiereMotivo = statusCambia || tierCambia;

  // Opciones de motivo según lo que cambió (status, tier o ambos).
  const motivoOpciones = [
    ...(statusCambia ? MOTIVOS_STATUS : []),
    ...(tierCambia ? MOTIVOS_TIER : [])
  ];

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (requiereMotivo && !motivo.trim()) {
      toast.error('Indicá el motivo del cambio.');
      return;
    }
    setSaving(true);
    try {
      const res = await actualizarMiembro(miembro.id, {
        nombre,
        telefono,
        email,
        status,
        membresia_tier: tier === '' ? null : tier,
        motivo: requiereMotivo ? motivo.trim() : undefined
      });
      if (res.sin_cambios) {
        toast.info('No había cambios para guardar.');
      } else {
        toast.success(`Datos actualizados (${res.cambios?.join(', ')}).`);
      }
      onGuardado();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar. Intentá de nuevo.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ek-backdrop" onClick={() => !saving && onClose()} role="dialog" aria-modal="true">
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="ek-card"
        style={{ maxWidth: '460px', width: '100%', maxHeight: '92vh', overflowY: 'auto', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard">EDITAR MIEMBRO</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="ek-stack-md">
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="em-nombre">Nombre</label>
            <input id="em-nombre" className="ek-input" value={nombre} onChange={(e) => setNombre(e.target.value)} autoComplete="off" />
          </div>
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="em-tel">Teléfono</label>
            <input id="em-tel" className="ek-input" value={telefono} onChange={(e) => setTelefono(e.target.value)} inputMode="tel" autoComplete="off" />
          </div>
          <div className="ek-form-field">
            <label className="ek-label" htmlFor="em-email">Email (acceso)</label>
            <input id="em-email" type="email" className="ek-input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            {emailCambia && (
              <p className="ek-helper-text" style={{ color: 'var(--ek-warning)' }}>
                Cambiar el email también cambia el correo con el que el cliente inicia sesión.
              </p>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="ek-form-field">
              <label className="ek-label" htmlFor="em-status">Estado</label>
              <select id="em-status" className="ek-input" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUS_OPCIONES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="ek-form-field">
              <label className="ek-label" htmlFor="em-tier">Plan</label>
              <select id="em-tier" className="ek-input" value={tier} onChange={(e) => setTier(e.target.value)}>
                {TIER_OPCIONES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {requiereMotivo && (
            <MotivoField
              opciones={motivoOpciones}
              onChange={setMotivo}
              idPrefix="em-motivo"
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
          <button type="button" className="ek-cta ek-cta--secondary" style={{ flex: 1 }} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="submit" className="ek-cta ek-cta--gold" style={{ flex: 1 }} disabled={saving}>
            {saving ? <Spinner size={16} /> : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  );
}
