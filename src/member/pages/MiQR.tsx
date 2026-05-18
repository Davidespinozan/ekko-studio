import { useEffect, useState, useRef } from 'react';
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
 * Las claves vienen del status de la reserva o del mensaje del servidor.
 */
function traducirErrorQR(raw: string): string {
  const msg = raw.toLowerCase();
  if (msg.includes('cancelada por admin') || msg.includes('cancelada_admin')) {
    return 'Esta reserva fue cancelada por administración. Contacta a EKKO si tienes dudas.';
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
  return raw;
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

  // Cargar datos de la reserva y emitir QR
  useEffect(() => {
    if (!reservaId) return;
    let mounted = true;

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
        setError(e instanceof Error ? e.message : 'Error generando QR');
        setIsLoading(false);
      }
    }

    load();
    return () => { mounted = false; };
  }, [reservaId]);

  // Renderizar QR con qr-code-styling
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

  if (isLoading) return <div className="ek-container"><p className="ek-body">Generando QR…</p></div>;

  if (error) {
    return (
      <div className="ek-container">
        <Link to="/app" className="adm-link">← Volver</Link>
        <p className="ek-error-text" style={{ marginTop: '1rem' }}>{traducirErrorQR(error)}</p>
      </div>
    );
  }

  return (
    <div className="ek-container">
      <div className="ek-stack-xl">
        <Link to="/app" className="adm-link">← Volver al inicio</Link>

        <div className="ek-stack-md">
          <p className="ek-eyebrow ek-eyebrow--mustard">TU QR DE ACCESO</p>
          <h1 className="ek-display-md">{reserva?.recurso?.nombre ?? 'Estudio'}</h1>
          <p className="ek-body-muted">
            {new Date(reserva.slot_inicio).toLocaleDateString('es-MX', {
              weekday: 'long', day: 'numeric', month: 'long'
            })}
            <br />
            {formatHora(new Date(reserva.slot_inicio))} – {formatHora(new Date(reserva.slot_fin))}
          </p>
        </div>

        {/* Contenedor blanco DELIBERADO: el scanner necesita contraste
            negro-sobre-blanco para decodificar de forma confiable.
            No cambiar a fondo oscuro. */}
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
          <div ref={qrContainerRef} />
          <p style={{ fontFamily: 'var(--ek-font-mono)', fontSize: '13px', color: '#0A0A0A' }}>
            {reserva?.folio}
          </p>
        </div>

        <div className="ek-card">
          <p className="ek-eyebrow" style={{ marginBottom: '8px' }}>INSTRUCCIONES</p>
          <p className="ek-body-muted">
            Muestra este código al llegar a EKKO. La recepción lo escanea
            para confirmar tu entrada.
            {expiresAt && (
              <>
                <br /><br />
                Válido hasta las {formatHora(expiresAt)} del día de tu sesión.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
