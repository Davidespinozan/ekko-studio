import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, UserPlus } from 'lucide-react';
import { PlanChip } from '@shared/components/PlanChip';
import { InvitadosModal } from './InvitadosModal';
import { playCheckInSuccess, playCheckInError } from '../lib/checkInFeedback';
import { avisoMembresia } from '../lib/avisoMembresia';
import { ZONA_ESTUDIO } from '@shared/lib/timezone';
import { VigenciaMembresia } from '@shared/components/VigenciaMembresia';

interface MiembroData {
  id: string;
  nombre: string | null;
  email: string;
  telefono: string | null;
  avatar_url: string | null;
  membresia_tier: string | null;
  notas_admin: string | null;
}

interface RecursoData {
  id: string;
  nombre: string;
}

interface ReservaData {
  id: string;
  folio: string;
  slot_inicio: string;
  slot_fin: string;
  duracion_min: number;
  invitados_count: number;
}

interface StatsData {
  check_ins_hoy: number;
  check_ins_semana: number;
}

interface Props {
  kind: 'success' | 'error';
  miembro?: MiembroData;
  recurso?: RecursoData;
  reserva?: ReservaData;
  stats?: StatsData;
  /** check_in_manual_atomic lo devuelve: 'ok' | 'sin_membresia' | 'vencida' | 'pago_pendiente' | 'cuenta_*'. */
  membresiaEstado?: string;
  errorMessage?: string;
  onClose: () => void;
}

const AUTO_CLOSE_MS = 15_000;

export function CheckInDetail({ kind, miembro, recurso, reserva, stats, membresiaEstado, errorMessage, onClose }: Props) {
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(AUTO_CLOSE_MS / 1000));
  const [invitadosOpen, setInvitadosOpen] = useState(false);
  const aviso = avisoMembresia(membresiaEstado);

  // Feedback sonoro + táctil al abrir el detalle (1 vez)
  useEffect(() => {
    if (kind === 'success') playCheckInSuccess();
    else playCheckInError();
  }, [kind]);

  useEffect(() => {
    // Pausa el auto-cierre mientras se registran invitados (flujo con foto).
    if (invitadosOpen) return;
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    const timeout = setTimeout(onClose, AUTO_CLOSE_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [onClose, invitadosOpen]);

  if (kind === 'error') {
    return (
      <div className="rec-detail rec-detail--error">
        <p
          className="rec-detail-eyebrow"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <AlertTriangle size={14} aria-hidden="true" />
          NO PUEDE ENTRAR
        </p>
        <p className="rec-detail-error-message">{errorMessage ?? 'QR no válido'}</p>
        <p style={{ color: 'rgba(245,241,232,0.6)', fontSize: '0.875rem', marginTop: '1rem' }}>
          Si necesitas anular o aclarar, avisa a admin.
        </p>
        <div className="rec-detail-footer">
          <button onClick={onClose} className="ek-cta ek-cta--full">
            Entendido
          </button>
          <p style={{ fontSize: '0.75rem', color: 'rgba(245,241,232,0.4)', marginTop: '0.5rem' }}>
            Cierra en {secondsLeft}s
          </p>
        </div>
      </div>
    );
  }

  if (!miembro || !recurso || !reserva) return null;

  const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-MX', { timeZone: ZONA_ESTUDIO,
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  const tieneTier = !!miembro.membresia_tier;

  return (
    <div className="rec-detail rec-detail--success">
      <p
        className="rec-detail-eyebrow"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
      >
        <CheckCircle2 size={14} aria-hidden="true" />
        CHECK-IN OK
      </p>

      <div className="rec-detail-header">
        <Avatar nombre={miembro.nombre ?? miembro.email} url={miembro.avatar_url} />
        <div>
          <h2 className="rec-detail-name">{miembro.nombre ?? '—'}</h2>
          <p className="rec-detail-contact">{miembro.email}</p>
          {miembro.telefono && <p className="rec-detail-contact">{miembro.telefono}</p>}
        </div>
      </div>

      <div className="rec-detail-divider" />

      <div className="rec-detail-grid">
        <Cell label="ESTUDIO" value={recurso.nombre} />
        <Cell label="HORA" value={`${hora(reserva.slot_inicio)} – ${hora(reserva.slot_fin)}`} />
        <Cell label="DURACIÓN" value={`${reserva.duracion_min} min`} />
        <Cell label="FOLIO" value={reserva.folio} mono />
        <Cell label="PERSONAS" value={`${1 + reserva.invitados_count}`} />
      </div>

      <div className="rec-detail-divider" />

      {aviso && (
        <div
          role="alert"
          data-testid="aviso-membresia"
          style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', border: '1px solid var(--ek-danger)', borderRadius: 'var(--ek-r-sm)', padding: '10px 12px', marginBottom: '12px', background: 'rgba(226,85,85,0.10)' }}
        >
          <AlertTriangle size={16} aria-hidden="true" style={{ color: 'var(--ek-danger)', flexShrink: 0, marginTop: '1px' }} />
          <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.4 }}>{aviso}</p>
        </div>
      )}

      <div className="rec-detail-grid">
        <div>
          <p className="rec-detail-section-label">MEMBRESÍA</p>
          <div style={{ marginTop: '2px' }}>
            {tieneTier ? (
              <>
                <PlanChip slug={miembro.membresia_tier} />
                <div style={{ marginTop: '4px' }}>
                  <VigenciaMembresia usuarioId={miembro.id} variante="linea" />
                </div>
              </>
            ) : (
              <p
                className="rec-detail-value"
                style={{ color: 'rgba(245,241,232,0.7)' }}
              >
                SIN PLAN
              </p>
            )}
          </div>
        </div>
        <Cell label="CHECK-IN HOY" value={`${stats?.check_ins_hoy ?? 1}`} />
        <Cell label="CHECK-IN SEMANA" value={`${stats?.check_ins_semana ?? 1}`} />
      </div>

      {miembro.notas_admin && (
        <>
          <div className="rec-detail-divider" />
          <div>
            <p className="rec-detail-section-label">NOTAS DEL MIEMBRO</p>
            <p className="rec-detail-notas">{miembro.notas_admin}</p>
          </div>
        </>
      )}

      <div className="rec-detail-footer">
        <button
          type="button"
          onClick={() => setInvitadosOpen(true)}
          className="ek-cta ek-cta--secondary ek-cta--full"
          style={{ marginBottom: '8px' }}
        >
          <UserPlus size={16} aria-hidden="true" /> Registrar invitados
        </button>
        <button onClick={onClose} className="ek-cta ek-cta--full">
          Listo
        </button>
        <p style={{ fontSize: '0.75rem', color: 'rgba(245,241,232,0.4)', marginTop: '0.5rem' }}>
          {invitadosOpen ? 'En pausa mientras registras invitados' : `Cierra en ${secondsLeft}s`}
        </p>
      </div>

      {invitadosOpen && (
        <InvitadosModal
          reservaId={reserva.id}
          miembroNombre={miembro.nombre ?? miembro.email ?? '—'}
          onClose={() => setInvitadosOpen(false)}
        />
      )}
    </div>
  );
}

function Cell({ label, value, mono, color }: { label: string; value: string; mono?: boolean; color?: string }) {
  return (
    <div>
      <p className="rec-detail-section-label">{label}</p>
      <p
        className="rec-detail-value"
        style={{
          fontFamily: mono ? 'var(--ek-font-mono)' : 'inherit',
          color: color ?? 'var(--ek-cream)'
        }}
      >
        {value}
      </p>
    </div>
  );
}

function Avatar({ nombre, url }: { nombre: string; url: string | null }) {
  if (url) {
    return <img src={url} alt={nombre} className="rec-detail-avatar" />;
  }
  const initials = nombre
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <div className="rec-detail-avatar rec-detail-avatar--initials">
      {initials || '?'}
    </div>
  );
}
