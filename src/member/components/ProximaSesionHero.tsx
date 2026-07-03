import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock, CalendarPlus } from 'lucide-react';
import { BotonCancelarReserva } from '@member/components/BotonCancelarReserva';

// ============================================================================
// ProximaSesionHero — hero SIEMPRE visible en el inicio del miembro (es lo que
// le da imagen a la pantalla). Usa una imagen FIJA de fondo con scrim.
//   · Con próxima sesión → fecha + estudio + folio + "Ver QR".
//   · Sin sesión → mensaje + "Reservar sesión".
// ============================================================================

// Imagen fija del hero del inicio (foto oficial de EKKO, en Supabase Storage).
// Si falla la carga, queda el fondo oscuro del contenedor.
const HERO_IMG =
  'https://cfihcrjbvgjiohedsjos.supabase.co/storage/v1/object/public/estudios/ekko/ChatGPT%20Image%2030%20may%202026,%2005_42_17%20p.m..jpg';

interface ReservaHero {
  id: string;
  slot_inicio: string;
  folio: string;
  recurso: { nombre: string | null } | null;
}

interface Props {
  reserva: ReservaHero | null;
  onCancelada: () => void;
}

function formatearFecha(iso: string): string {
  const d = new Date(iso);
  const fecha = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  const hora = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fecha} · ${hora}`;
}

export function ProximaSesionHero({ reserva, onCancelada }: Props) {
  const nombre = reserva?.recurso?.nombre ?? 'Estudio';

  return (
    <div className="ek-hero-foto ek-lift" style={{ marginBottom: '24px', background: 'var(--ek-bg-elevated)' }}>
      <img className="ek-hero-foto-img" src={HERO_IMG} alt="" loading="lazy" />
      <div className="ek-hero-foto-scrim" />
      <div className="ek-hero-foto-body">
        {reserva ? (
          <>
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
          </>
        ) : (
          <>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>TU PRÓXIMA SESIÓN</p>
            <h2 className="ek-display-lg" style={{ marginBottom: '6px', color: '#fff' }}>Aún no tenés una agendada</h2>
            <p style={{ fontSize: '13.5px', color: 'rgba(255,255,255,0.72)', marginBottom: '20px' }}>
              Reservá tu próxima grabación y aparecerá acá con tu QR de acceso.
            </p>
            <Link to="/app/reservar" className="ek-cta ek-cta--gold">
              Reservar ahora <CalendarPlus size={16} aria-hidden="true" />
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
