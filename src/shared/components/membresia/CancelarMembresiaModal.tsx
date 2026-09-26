import { useState } from 'react';
import { CircleSlash } from 'lucide-react';
import { useToast } from '@shared/hooks/useToast';
import { backendPost } from '@shared/lib/backend';
import { formatFechaEnZona } from '@shared/lib/timezone';
import { ModalAccion } from './ModalAccion';

interface Props {
  usuarioId: string;
  nombre: string | null;
  /** ¿Tiene suscripción de Stripe? Solo entonces existe "al fin del periodo". */
  conSuscripcion: boolean;
  enPausa: boolean;
  periodoFin: string | null;
  creditos: number | null;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

interface Respuesta {
  success: boolean;
  inmediata: boolean;
  stripe_cancelado: boolean | null;
}

/**
 * Dar de baja la membresía desde mostrador / admin (function
 * `staff-cancelar-membresia`). EKKO es mes a mes: "me quiero dar de baja" es una
 * petición de recepción, y antes solo el miembro podía hacerlo desde su app.
 */
export function CancelarMembresiaModal({
  usuarioId, nombre, conSuscripcion, enPausa, periodoFin, creditos, onClose, onDone
}: Props) {
  const toast = useToast();
  // Con suscripción viva, lo normal es NO renovar y dejarle lo que ya pagó.
  const puedeEsperarAlFin = conSuscripcion && !enPausa;
  const [inmediata, setInmediata] = useState(!puedeEsperarAlFin);
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);

  const fin = periodoFin ? formatFechaEnZona(periodoFin, { day: 'numeric', month: 'long' }) : null;
  const pierdeCreditos = inmediata && (creditos ?? 0) > 0;

  async function confirmar() {
    if (motivo.trim().length < 5) {
      toast.error('Indica el motivo de la baja.');
      return;
    }
    setGuardando(true);
    try {
      const r = await backendPost<Respuesta>('staff-cancelar-membresia', {
        usuario_id: usuarioId,
        motivo: motivo.trim(),
        inmediata
      });
      if (r.stripe_cancelado === false) {
        toast.warning('Membresía dada de baja, pero Stripe no confirmó la cancelación. Avisa al administrador para revisarla.', 12_000);
      } else {
        toast.success(r.inmediata ? 'Membresía dada de baja.' : `No se renovará${fin ? `; conserva su acceso hasta el ${fin}` : ''}.`);
      }
      await onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo dar de baja la membresía.');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <ModalAccion
      titulo="DAR DE BAJA LA MEMBRESÍA"
      icono={<CircleSlash size={14} aria-hidden="true" />}
      sujeto={nombre ?? 'Miembro'}
      confirmarLabel={inmediata ? 'Dar de baja ahora' : 'No renovar'}
      peligro
      guardando={guardando}
      onSubmit={confirmar}
      onClose={onClose}
    >
      {puedeEsperarAlFin ? (
        <div role="radiogroup" aria-label="Cuándo" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '14px' }}>
          <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="radio" name="cuando" checked={!inmediata} onChange={() => setInmediata(false)} style={{ marginTop: '3px' }} />
            <span style={{ fontSize: '13px', lineHeight: 1.45 }}>
              <strong>No renovar</strong> — conserva su acceso{fin ? ` hasta el ${fin}` : ' hasta el fin del periodo'}, que ya pagó. Es lo habitual.
            </span>
          </label>
          <label style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="radio" name="cuando" checked={inmediata} onChange={() => setInmediata(true)} style={{ marginTop: '3px' }} />
            <span style={{ fontSize: '13px', lineHeight: 1.45 }}>
              <strong>Ahora mismo</strong> — pierde el acceso hoy y se cancela la suscripción en Stripe. No se reembolsa nada automáticamente.
            </span>
          </label>
        </div>
      ) : (
        <p className="ek-body-muted" style={{ fontSize: '13px', lineHeight: 1.5, margin: '0 0 14px' }}>
          {enPausa
            ? 'La membresía está en pausa: se cierra de inmediato y se cancela la suscripción en Stripe.'
            : 'Esta membresía no tiene suscripción de Stripe (se activó en mostrador): la baja es inmediata y el miembro deja de poder reservar.'}
        </p>
      )}

      {pierdeCreditos && (
        <p role="alert" style={{ fontSize: '13px', lineHeight: 1.45, margin: '0 0 14px', padding: '10px 12px', borderRadius: 'var(--ek-r-sm)', border: '1px solid var(--ek-danger)', background: 'rgba(226,85,85,0.10)' }}>
          Le quedan <strong>{creditos} {creditos === 1 ? 'crédito' : 'créditos'}</strong>: con la baja inmediata <strong>se pierden</strong> (queda asentado en su historial).
        </p>
      )}

      <label className="ek-label" style={{ display: 'block' }}>
        Motivo
        <input
          className="ek-input"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Ej. Se muda de ciudad"
          maxLength={200}
        />
      </label>
      <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: '8px 0 0', lineHeight: 1.45 }}>
        Sus reservas futuras no se cancelan solas: revísalas abajo. Se le avisa al miembro en la app.
      </p>
    </ModalAccion>
  );
}
