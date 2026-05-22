import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import QRCodeStyling from 'qr-code-styling';
import { supabase } from '@shared/lib/supabase';
import { backendPost } from '@shared/lib/backend';
import { formatHora } from '@member/logic/reservaLogic';

interface IssueResponse {
  qr_payload: string;
  expires_at: string;
}

/**
 * Traduce errores del backend qr-issue a copy human-friendly.
 * Exportada para test (ERROR-UI-FIX E-05).
 */
export function traducirErrorQR(raw: string): string {
  const msg = raw.toLowerCase();
  if (msg.includes('cancelada por admin') || msg.includes('cancelada_admin')) {
    return 'Esta reserva fue cancelada por el estudio. Contactanos si tenés dudas.';
  }
  if (msg.includes('cancelada')) {
    return 'Esta reserva fue cancelada.';
  }
  if (msg.includes('completada') || msg.includes('check-in')) {
    return 'Ya hiciste check-in para esta reserva.';
  }
  if (msg.includes('no_show') || msg.includes('no-show')) {
    return 'Esta reserva expiró sin check-in.';
  }
  if (msg.includes('no autorizada') || msg.includes('no encontrada')) {
    return 'Esta reserva no existe o no es tuya.';
  }
  if (msg.includes('fuera de ventana')) {
    return 'Esta reserva queda fuera de la ventana de QR (más de 7 días).';
  }
  // Fallback (ERROR-UI-FIX E-05): nunca mostrar el mensaje crudo de
  // Supabase/HTTP. Cualquier código no contemplado cae a un genérico.
  return 'No se pudo generar tu código QR. Intentá de nuevo.';
}

function QRSkeleton() {
  return (
    <div
      className="ek-skeleton"
      style={{
        aspectRatio: '1 / 1',
        width: '100%',
        borderRadius: 'var(--ek-r-card)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <span
        style={{
          fontSize: '12px',
          color: 'var(--ek-ink-faint)',
          letterSpacing: '0.14em',
          fontWeight: 600
        }}
      >
        GENERANDO TU CÓDIGO…
      </span>
    </div>
  );
}

function QRError({ mensaje, onReintentar }: { mensaje: string; onReintentar: () => void }) {
  return (
    <div
      style={{
        aspectRatio: '1 / 1',
        width: '100%',
        borderRadius: 'var(--ek-r-card)',
        background: 'var(--ek-bg-soft)',
        border: '0.5px solid var(--ek-line)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '14px',
        padding: '24px',
        textAlign: 'center'
      }}
    >
      <p
        style={{
          fontSize: '14px',
          color: 'var(--ek-ink)',
          lineHeight: 1.5,
          margin: 0
        }}
      >
        {mensaje}
      </p>
      <button
        type="button"
        onClick={onReintentar}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--ek-mustard)',
          fontSize: '13px',
          fontWeight: 600,
          cursor: 'pointer',
          padding: '6px 10px'
        }}
      >
        Reintentar →
      </button>
    </div>
  );
}

export default function MiQR() {
  const { reservaId } = useParams<{ reservaId: string }>();
  const qrContainerRef = useRef<HTMLDivElement>(null);
  const qrInstance = useRef<QRCodeStyling | null>(null);

  const [reserva, setReserva] = useState<any>(null);
  const [qrPayload, setQrPayload] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const generarQR = useCallback(() => {
    setRetryTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!reservaId) return;
    let mounted = true;
    setIsLoading(true);
    setError(null);

    async function load() {
      const { data: r } = await supabase
        .from('reservas')
        .select('*, recurso:recursos(id, slug, nombre)')
        .eq('id', reservaId!)
        .maybeSingle();

      if (!mounted) return;
      if (!r) {
        setError('Reserva no encontrada');
        setIsLoading(false);
        return;
      }
      setReserva(r);

      try {
        const res = await backendPost<IssueResponse>('qr-issue', { reserva_id: reservaId });
        if (!mounted) return;
        setQrPayload(res.qr_payload);
        setExpiresAt(new Date(res.expires_at));
        setIsLoading(false);
      } catch (e) {
        if (!mounted) return;
        setError(e instanceof Error ? e.message : 'No se pudo generar el QR');
        setIsLoading(false);
      }
    }

    load();
    return () => { mounted = false; };
  }, [reservaId, retryTick]);

  useEffect(() => {
    if (!qrPayload || !qrContainerRef.current) return;

    qrInstance.current = new QRCodeStyling({
      width: 320,
      height: 320,
      type: 'svg',
      data: qrPayload,
      margin: 16,
      dotsOptions: { color: '#0A0A0A', type: 'square' },
      backgroundOptions: { color: '#FFFFFF' },
      cornersSquareOptions: { color: '#0A0A0A', type: 'square' },
      cornersDotOptions: { color: '#0A0A0A', type: 'square' },
      qrOptions: { errorCorrectionLevel: 'M' }
    });

    qrContainerRef.current.innerHTML = '';
    qrInstance.current.append(qrContainerRef.current);
  }, [qrPayload]);

  return (
    <div className="ek-container">
      <div className="ek-stack-xl" style={{ maxWidth: 'min(24rem, 100%)', margin: '0 auto', width: '100%' }}>
        <Link to="/app" className="adm-link">← Volver al inicio</Link>

        {reserva && (
          <div className="ek-stack-md">
            <p className="ek-eyebrow ek-eyebrow--mustard">TU QR DE ACCESO</p>
            <h1 className="ek-display-md">{reserva.recurso?.nombre ?? 'Estudio'}</h1>
            <p className="ek-body-muted">
              {new Date(reserva.slot_inicio).toLocaleDateString('es-MX', {
                weekday: 'long', day: 'numeric', month: 'long'
              })}
              <br />
              {formatHora(new Date(reserva.slot_inicio))} – {formatHora(new Date(reserva.slot_fin))}
            </p>
          </div>
        )}

        {isLoading ? (
          <QRSkeleton />
        ) : error ? (
          <QRError mensaje={traducirErrorQR(error)} onReintentar={generarQR} />
        ) : qrPayload ? (
          /* Contenedor blanco DELIBERADO: el scanner necesita contraste
             negro-sobre-blanco para decodificar de forma confiable.
             No cambiar a fondo oscuro. */
          <div
            style={{
              background: '#FFFFFF',
              borderRadius: 'var(--ek-r-card)',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px'
            }}
          >
            <div ref={qrContainerRef} style={{ width: '100%', maxWidth: '320px' }} />
            <p style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '13px', color: '#0A0A0A' }}>
              {reserva?.folio}
            </p>
          </div>
        ) : null}

        {!isLoading && !error && (
          <div className="ek-card">
            <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>INSTRUCCIONES</p>
            <p className="ek-body-muted">
              Mostrá este código al llegar al estudio. La recepción lo escanea
              para confirmar tu entrada.
              {expiresAt && (
                <>
                  <br /><br />
                  Válido hasta las {formatHora(expiresAt)} del día de tu sesión.
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
