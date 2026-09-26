import { CalendarPlus } from 'lucide-react';
import { useTenant } from '@shared/hooks/useTenant';
import { useLandingConfig } from '@shared/hooks/useLandingConfig';
import { descargarICS, urlGoogleCalendar, type EventoReserva } from '@shared/lib/calendario';

interface Props {
  reserva: {
    id: string;
    folio: string | null;
    slot_inicio: string;
    slot_fin: string;
    invitados_count?: number | null;
    recurso_nombre: string;
  };
  /** true justo después de reservar: se presenta como el siguiente paso, no como una opción más. */
  destacado?: boolean;
}

/**
 * "Agregar al calendario" — Apple Calendar (.ics) o Google Calendar. La invitación
 * lleva fecha y hora, set, duración, ubicación, folio e invitados, el enlace al QR
 * y el contacto del estudio (solicitud de cambios del cliente, punto 1).
 *
 * Dirección y contacto salen de lo que el estudio ya configuró en Admin → Landing
 * (pie de página) y Admin → Contacto: si faltan, la invitación simplemente no los
 * incluye.
 */
export function AgregarAlCalendario({ reserva, destacado = false }: Props) {
  const tenant = useTenant();
  const { footer, contacto } = useLandingConfig();

  const evento: EventoReserva = {
    reservaId: reserva.id,
    folio: reserva.folio,
    set: reserva.recurso_nombre,
    inicio: reserva.slot_inicio,
    fin: reserva.slot_fin,
    estudio: tenant.nombre ?? 'EKKO Studio',
    direccion: footer.direccion || null,
    whatsapp: contacto.whatsapp_e164 || null,
    email: footer.email || null,
    urlReserva: typeof window !== 'undefined' ? `${window.location.origin}/app/qr/${reserva.id}` : null,
    invitados: reserva.invitados_count ?? 0
  };

  return (
    <div className="ek-card" data-testid="agregar-al-calendario" style={destacado ? { borderColor: 'var(--ek-mustard-dim)' } : undefined}>
      <p className="ek-eyebrow" style={{ marginBottom: '6px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        <CalendarPlus size={13} aria-hidden="true" /> AGREGAR AL CALENDARIO
      </p>
      <p className="ek-body-muted" style={{ margin: '0 0 12px', fontSize: '13px' }}>
        {destacado
          ? 'Guárdala para que no se te pase: te avisa una hora antes.'
          : 'Con la hora, el set, la ubicación y tu folio. Te avisa una hora antes.'}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <button type="button" className="ek-cta ek-cta--secondary" onClick={() => descargarICS(evento)}>
          Apple Calendar
        </button>
        <a
          className="ek-cta ek-cta--secondary"
          href={urlGoogleCalendar(evento)}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'none', textAlign: 'center' }}
        >
          Google Calendar
        </a>
      </div>
      <p className="ek-helper-text" style={{ margin: '8px 0 0' }}>
        ¿Usas Outlook u otra app? "Apple Calendar" descarga un archivo .ics que también abre ahí.
      </p>
    </div>
  );
}
