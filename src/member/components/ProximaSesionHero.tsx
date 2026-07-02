import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock } from 'lucide-react';
import { BotonCancelarReserva } from '@member/components/BotonCancelarReserva';

// ============================================================================
// ProximaSesionHero — hero inmersivo de la próxima sesión. Si el estudio tiene
// foto, la usa de fondo con un scrim en gradiente + botones "glass"; si no,
// cae a la card oscura de siempre. Patrón tomado de SALA (ProximaClaseHero).
// ============================================================================

interface Props {
  reserva: {
    id: string;
    slot_inicio: string;
    folio: string;
    recurso: { nombre: string | null; foto_url: string | null } | null;
  };
  onCancelada: () => void;
}

function formatearFecha(iso: string): string {
  const d = new Date(iso);
  const fecha = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fecha} · ${hora}`;
}

export function ProximaSesionHero({ reserva, onCancelada }: Props) {
  const nombre = reserva.recurso?.nombre ?? 'Estudio';
  const foto = reserva.recurso?.foto_url ?? null;

  // Sin foto → card oscura clásica (misma que antes, con ek-lift).
  if (!foto) {
    return (
      <div className="ek-card--hero ek-lift" style={{ marginBottom: '24px' }}>
        <h2 className="ek-display-lg" style={{ marginBottom: '6px' }}>{nombre}</h2>
        <p className="ek-body-muted" style={{ marginBottom: '14px' }}>{formatearFecha(reserva.slot_inicio)}</p>
        <p className="ek-body-faint" style={{ marginBottom: '20px' }}>
          Folio: <span style={{ fontFamily: 'var(--ek-font-mono)' }}>{reserva.folio}</span>
        </p>
        <Link to={`/app/qr/${reserva.id}`} className="ek-cta">
          Ver QR <ArrowRight size={16} aria-hidden="true" />
        </Link>
        <div style={{ marginTop: '14px' }}>
          <BotonCancelarReserva
            reserva={{ id: reserva.id, slot_inicio: reserva.slot_inicio, folio: reserva.folio, recurso_nombre: nombre }}
            onCancelada={onCancelada}
          />
        </div>
      </div>
    );
  }

  // Con foto → hero inmersivo.
  return (
    <div className="ek-hero-foto ek-lift" style={{ marginBottom: '24px' }}>
      <img className="ek-hero-foto-img" src={foto} alt={nombre} loading="lazy" />
      <div className="ek-hero-foto-scrim" />
      <div className="ek-hero-foto-body">
        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <CalendarClock size={13} aria-hidden="true" /> {formatearFecha(reserva.slot_inicio)}
        </p>
        <h2 className="ek-display-lg" style={{ marginBottom: '6px', color: '#fff' }}>{nombre}</h2>
        <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginBottom: '20px' }}>
          Folio: <span style={{ fontFamily: 'var(--ek-font-mono)' }}>{reserva.folio}</span>
        </p>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <Link to={`/app/qr/${reserva.id}`} className="ek-cta ek-cta--gold">
            Ver QR <ArrowRight size={16} aria-hidden="true" />
          </Link>
          <BotonCancelarReserva
            reserva={{ id: reserva.id, slot_inicio: reserva.slot_inicio, folio: reserva.folio, recurso_nombre: nombre }}
            onCancelada={onCancelada}
          />
        </div>
      </div>
    </div>
  );
}
