import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock, CalendarPlus, UserPlus } from 'lucide-react';
import { BotonCancelarReserva } from '@member/components/BotonCancelarReserva';
import { PagarInvitadosExtra } from '@member/components/PagarInvitadosExtra';
import { useTenant } from '@shared/hooks/useTenant';
import { formatFechaEnZona, formatHoraEnZona } from '@shared/lib/timezone';
import { sesionEnCurso } from '@member/logic/reservasVigentes';

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
  invitados_extra_pagados?: number | null;
  recurso: { nombre: string | null; max_invitados_extra?: number | null } | null;
}

interface Props {
  reserva: ReservaHero | null;
  onCancelada: () => void;
}

/** En la zona del ESTUDIO: la misma fecha y hora que ve recepción y que dice el QR. */
function formatearFecha(iso: string): string {
  const fecha = formatFechaEnZona(iso, { weekday: 'long', day: 'numeric', month: 'long' });
  return `${fecha} · ${formatHoraEnZona(iso)}`;
}

export function ProximaSesionHero({ reserva, onCancelada }: Props) {
  const tenant = useTenant();
  const nombre = reserva?.recurso?.nombre ?? 'Estudio';
  const [invitadosOpen, setInvitadosOpen] = useState(false);
  const enCurso = !!reserva && sesionEnCurso(reserva.slot_inicio);

  const precioExtraCentavos = Number((tenant.config as Record<string, any>)?.reserva?.precio_invitado_extra_centavos) || 0;
  const restanteExtra = (reserva?.recurso?.max_invitados_extra ?? 0) - (reserva?.invitados_extra_pagados ?? 0);
  const puedeExtras = !!reserva && precioExtraCentavos > 0 && restanteExtra > 0;

  return (
    <div className="ek-hero-foto ek-lift" style={{ marginBottom: '24px', background: 'var(--ek-bg-elevated)' }}>
      <img className="ek-hero-foto-img" src={HERO_IMG} alt="" loading="lazy" />
      <div className="ek-hero-foto-scrim" />
      <div className="ek-hero-foto-body">
        {reserva ? (
          <>
            <p className="ek-eyebrow" style={{ marginBottom: '10px', display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'rgba(255,255,255,0.92)' }}>
              <CalendarClock size={13} aria-hidden="true" />{' '}
              {enCurso ? `EN CURSO · empezó a las ${formatHoraEnZona(reserva.slot_inicio)}` : formatearFecha(reserva.slot_inicio)}
            </p>
            <h2 className="ek-display-lg" style={{ marginBottom: '22px', color: '#fff' }}>{nombre}</h2>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
              <Link to={`/app/qr/${reserva.id}`} className="ek-cta ek-cta--gold">
                Ver QR <ArrowRight size={16} aria-hidden="true" />
              </Link>
              {/* Una sesión que ya empezó no se cancela: solo queda enseñar el QR. */}
              {!enCurso && (
                <BotonCancelarReserva
                  reserva={{ id: reserva.id, slot_inicio: reserva.slot_inicio, folio: reserva.folio, recurso_nombre: nombre, invitados_extra_pagados: reserva.invitados_extra_pagados }}
                  onCancelada={onCancelada}
                />
              )}
              {puedeExtras && (
                <button
                  type="button"
                  onClick={() => setInvitadosOpen(true)}
                  className="ek-cta ek-cta--secondary"
                >
                  <UserPlus size={15} aria-hidden="true" /> Invitados extra
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '10px' }}>TU PRÓXIMA SESIÓN</p>
            <h2 className="ek-display-lg" style={{ marginBottom: '6px', color: '#fff' }}>Aún no tienes una agendada</h2>
            <p style={{ fontSize: '13.5px', color: 'rgba(255,255,255,0.72)', marginBottom: '20px' }}>
              Reserva tu próxima grabación y aparecerá aquí con tu QR de acceso.
            </p>
            <Link to="/app/reservar" className="ek-cta ek-cta--gold">
              Reservar ahora <CalendarPlus size={16} aria-hidden="true" />
            </Link>
          </>
        )}
      </div>

      {invitadosOpen && reserva && (
        <PagarInvitadosExtra
          reservaId={reserva.id}
          precioExtraCentavos={precioExtraCentavos}
          maxCantidad={restanteExtra}
          onClose={() => setInvitadosOpen(false)}
          onPagado={() => setInvitadosOpen(false)}
        />
      )}
    </div>
  );
}
