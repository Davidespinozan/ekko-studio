import { useState } from 'react';
import { Coins, Minus, Plus } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { useToast } from '@shared/hooks/useToast';
import { ModalAccion } from './ModalAccion';

interface Props {
  usuarioId: string;
  nombre: string | null;
  saldoActual: number;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}

const MOTIVOS = [
  'Falla del estudio o del equipo',
  'Cortesía',
  'Corrección de un error de captura',
  'Reembolso hecho en Stripe'
];

/** Quita el prefijo EKKO_CODIGO: de los errores del RPC. */
function humano(mensaje: string): string {
  return mensaje.includes(': ') ? mensaje.split(': ').slice(1).join(': ') : mensaje;
}

/**
 * Abonar o descontar créditos con motivo (RPC `staff_ajustar_creditos`): se cayó
 * la luz a media sesión, una cortesía, un reembolso. Antes no había forma salvo
 * editar el saldo por SQL, que descuadra el ledger y no deja rastro.
 */
export function AjustarCreditosModal({ usuarioId, nombre, saldoActual, onClose, onDone }: Props) {
  const toast = useToast();
  const [delta, setDelta] = useState(1);
  const [motivo, setMotivo] = useState('');
  const [guardando, setGuardando] = useState(false);

  const resultante = saldoActual + delta;
  const invalido = delta === 0 || resultante < 0 || Math.abs(delta) > 50;

  async function confirmar() {
    if (motivo.trim().length < 5) {
      toast.error('Indica el motivo del ajuste.');
      return;
    }
    setGuardando(true);
    try {
      // Cast: la RPC es nueva y aún no está en los tipos generados de Supabase.
      const { error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>
      ) => Promise<{ error: { message: string } | null }>)('staff_ajustar_creditos', {
        p_usuario_id: usuarioId,
        p_delta: delta,
        p_motivo: motivo.trim()
      });
      if (error) throw new Error(humano(error.message));
      toast.success(
        delta > 0
          ? `Se abonaron ${delta} ${delta === 1 ? 'crédito' : 'créditos'}. Saldo: ${resultante}.`
          : `Se descontaron ${-delta} ${delta === -1 ? 'crédito' : 'créditos'}. Saldo: ${resultante}.`
      );
      await onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo ajustar el saldo.');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <ModalAccion
      titulo="AJUSTAR CRÉDITOS"
      icono={<Coins size={14} aria-hidden="true" />}
      sujeto={nombre ?? 'Miembro'}
      confirmarLabel={delta >= 0 ? 'Abonar' : 'Descontar'}
      guardando={guardando}
      bloqueado={invalido}
      onSubmit={confirmar}
      onClose={onClose}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px', margin: '4px 0 6px' }}>
        <button type="button" className="ek-icon-btn" aria-label="Un crédito menos" onClick={() => setDelta((d) => Math.max(-50, d - 1))}>
          <Minus size={18} aria-hidden="true" />
        </button>
        <span aria-live="polite" style={{ fontFamily: 'var(--ek-font-display)', fontSize: '32px', fontWeight: 700, minWidth: '80px', textAlign: 'center' }}>
          {delta > 0 ? `+${delta}` : delta}
        </span>
        <button type="button" className="ek-icon-btn" aria-label="Un crédito más" onClick={() => setDelta((d) => Math.min(50, d + 1))}>
          <Plus size={18} aria-hidden="true" />
        </button>
      </div>
      <p style={{ textAlign: 'center', fontSize: '13px', color: resultante < 0 ? 'var(--ek-danger)' : 'var(--ek-ink-muted)', margin: '0 0 14px' }}>
        {resultante < 0
          ? `Solo le quedan ${saldoActual}: no se pueden quitar ${-delta}.`
          : `Saldo: ${saldoActual} → ${resultante}`}
      </p>

      <label className="ek-label" htmlFor="ac-motivo" style={{ display: 'block' }}>Motivo</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '6px 0 8px' }}>
        {MOTIVOS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMotivo(m)}
            className="ek-cta ek-cta--secondary"
            style={{ minHeight: '32px', padding: '4px 10px', fontSize: '12px', borderColor: motivo === m ? 'var(--ek-mustard)' : undefined }}
          >
            {m}
          </button>
        ))}
      </div>
      <input
        id="ac-motivo"
        className="ek-input"
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder="Qué pasó"
        maxLength={200}
      />
      <p style={{ fontSize: '12px', color: 'var(--ek-ink-faint)', margin: '8px 0 0', lineHeight: 1.45 }}>
        Queda en el historial con tu nombre y se le avisa al miembro en la app.
      </p>
    </ModalAccion>
  );
}
