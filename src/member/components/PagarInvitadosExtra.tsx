import { useEffect, useRef, useState } from 'react';
import { X, UserPlus, Check } from 'lucide-react';
import { PaymentModal } from '@shared/components/PaymentModal';
import { Spinner } from '@shared/components/Spinner';
import { ErrorInline } from '@shared/components/ErrorCarga';
import { crearPagoInvitados } from '@shared/lib/checkout';
import { supabase } from '@shared/lib/supabase';
import { observarActivacion } from '@shared/lib/observarActivacion';
import { limpiarPagoPendiente, MENSAJE_PAGO, type PagoConfirmado } from '@shared/lib/pagoEstado';

/**
 * Pagar invitados EXTRA de una reserva YA creada (Stripe, tarjeta guardada).
 * Paso 1: elegir cuántos (o `cantidadFija`). Paso 2: PaymentModal con el total.
 * Paso 3 (PKG-02B · C04): con el pago CONFIRMADO se observa la reserva hasta que
 * `invitados_extra_pagados` refleje el registro (lo hace el webhook). No se suma
 * "+1" en memoria ni se afirma "pagados" antes de verlo. Todo por Stripe.
 */
interface Props {
  reservaId: string;
  precioExtraCentavos: number;
  /** Cuántos más puede pagar (tope del estudio − ya pagados). */
  maxCantidad: number;
  /** Invitados extra ya pagados en la reserva (para saber cuándo se registraron los nuevos). */
  pagadosActuales?: number;
  /** Saltar el paso de elegir cantidad (p. ej. ya elegida al reservar). */
  cantidadFija?: number;
  onClose: () => void;
  /** Los invitados quedaron REGISTRADOS en la reserva; `total` = invitados_extra_pagados observado. */
  onRegistrado: (total: number) => void;
  /** Pago confirmado o en proceso pero el registro aún no se observa (el llamador refresca luego). */
  onPendiente?: () => void;
}

type Fase = 'cantidad' | 'pago' | 'observando' | 'no_observada' | 'error' | 'en_proceso';

export function PagarInvitadosExtra({ reservaId, precioExtraCentavos, maxCantidad, pagadosActuales = 0, cantidadFija, onClose, onRegistrado, onPendiente }: Props) {
  const tope = Math.max(1, maxCantidad);
  const [cantidad, setCantidad] = useState(cantidadFija ?? 1);
  const [fase, setFase] = useState<Fase>(cantidadFija ? 'pago' : 'cantidad');
  const precioPesos = Math.round(precioExtraCentavos / 100);
  const desmontado = useRef(false);
  useEffect(() => () => { desmontado.current = true; }, []);

  async function observarRegistro() {
    setFase('observando');
    const esperado = pagadosActuales + cantidad;
    const obs = await observarActivacion<{ invitados_extra_pagados: number | null }>({
      leer: async () => {
        const { data, error } = await supabase.from('reservas').select('invitados_extra_pagados').eq('id', reservaId).maybeSingle();
        return { data: (data as { invitados_extra_pagados: number | null } | null) ?? null, error };
      },
      listo: (r) => (r.invitados_extra_pagados ?? 0) >= esperado,
      cancelado: () => desmontado.current
    });
    if (desmontado.current) return;
    if (obs.resultado === 'observada') {
      limpiarPagoPendiente();
      onRegistrado(obs.dato.invitados_extra_pagados ?? esperado);
      return;
    }
    setFase(obs.resultado === 'error' ? 'error' : 'no_observada');
    onPendiente?.();
  }

  if (fase === 'pago') {
    return (
      <PaymentModal
        precio={precioPesos * cantidad}
        titulo="Invitados extra"
        subtitulo={`${cantidad} ${cantidad === 1 ? 'invitado' : 'invitados'} × $${precioPesos.toLocaleString('es-MX')} = $${(precioPesos * cantidad).toLocaleString('es-MX')}`}
        pedirNombre={false}
        flujo="invitados"
        contexto={{ reservaId, cantidad }}
        // PKG-01C: una intención por (reserva, cantidad); el reintento reutiliza la misma operación.
        objetivoOperacion={`invitados:${reservaId}:${cantidad}`}
        fetchIntent={(operationId) => crearPagoInvitados(reservaId, cantidad, operationId)}
        onClose={onClose}
        onPagado={(_pago: PagoConfirmado) => { void observarRegistro(); }}
        onEnProceso={() => { setFase('en_proceso'); onPendiente?.(); }}
      />
    );
  }

  if (fase === 'observando' || fase === 'no_observada' || fase === 'error' || fase === 'en_proceso') {
    return (
      <div className="ek-backdrop" role="dialog" aria-modal="true">
        <div className="ek-card" data-testid="invitados-pendiente" style={{ maxWidth: '400px', width: '100%', textAlign: 'center' }}>
          <span className="ek-empty-icon" style={{ width: 48, height: 48, marginBottom: '12px' }}>
            <Check size={22} aria-hidden="true" />
          </span>
          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '8px' }}>
            {fase === 'en_proceso' ? 'PAGO EN PROCESO' : 'PAGO RECIBIDO'}
          </p>
          <p className="ek-body-muted" style={{ margin: '0 0 14px', lineHeight: 1.5 }}>
            {fase === 'observando' && 'Estamos registrando tus invitados; suele tardar unos segundos.'}
            {fase === 'no_observada' && 'El registro está tardando más de lo normal. No vuelvas a pagar: en cuanto se refleje, aparecerá en tu reserva.'}
            {fase === 'en_proceso' && MENSAJE_PAGO.enProceso}
          </p>
          {fase === 'error' && (
            <div style={{ marginBottom: '12px', textAlign: 'left' }}>
              <ErrorInline mensaje="No pudimos comprobar el registro de tus invitados. Revisa tu conexión e intenta de nuevo." />
            </div>
          )}
          {fase === 'observando' ? (
            <Spinner size={18} />
          ) : (
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
              {fase !== 'en_proceso' && (
                <button type="button" className="ek-cta ek-cta--gold" onClick={() => void observarRegistro()}>
                  Volver a comprobar
                </button>
              )}
              <button type="button" className="ek-cta ek-cta--secondary" onClick={onClose}>
                Cerrar
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    // Elegir cantidad; cierra solo con ✕ (paso previo a un pago).
    <div className="ek-backdrop" role="dialog" aria-modal="true">
      <div className="ek-card" style={{ maxWidth: '400px', width: '100%', animation: 'ek-scale-in 0.22s cubic-bezier(0.16,1,0.3,1)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
          <p className="ek-eyebrow ek-eyebrow--mustard"><UserPlus size={12} aria-hidden="true" /> INVITADOS EXTRA</p>
          <button type="button" className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Cerrar" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="ek-body-muted" style={{ margin: '0 0 18px', fontSize: '14px' }}>
          ${precioPesos.toLocaleString('es-MX')} por invitado. Se cobra a tu tarjeta.
        </p>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', justifyContent: 'center', marginBottom: '14px' }}>
          <button
            type="button"
            onClick={() => setCantidad(Math.max(1, cantidad - 1))}
            disabled={cantidad === 1}
            className="ek-cta ek-cta--secondary"
            style={{ minHeight: '44px', minWidth: '44px', padding: '0 0.75rem' }}
          >
            −
          </button>
          <span style={{ fontSize: '1.6rem', fontWeight: 700, minWidth: '48px', textAlign: 'center' }}>{cantidad}</span>
          <button
            type="button"
            onClick={() => setCantidad(Math.min(tope, cantidad + 1))}
            disabled={cantidad >= tope}
            className="ek-cta ek-cta--secondary"
            style={{ minHeight: '44px', minWidth: '44px', padding: '0 0.75rem' }}
          >
            +
          </button>
        </div>

        <button type="button" className="ek-cta ek-cta--gold ek-cta--full" onClick={() => setFase('pago')}>
          Pagar ${(precioPesos * cantidad).toLocaleString('es-MX')}
        </button>
      </div>
    </div>
  );
}
