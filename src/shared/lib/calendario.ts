/**
 * "Agregar al calendario" (solicitud de cambios del cliente, punto 1).
 *
 * Dos salidas a partir de la misma reserva:
 *  · `.ics` (iCalendar, RFC 5545) → Apple Calendar, y también Outlook y cualquier
 *    app de calendario: en iPhone/Mac abrir el archivo ofrece "Agregar".
 *  · enlace de Google Calendar (`/calendar/render?action=TEMPLATE`).
 *
 * Todo en el navegador, sin backend. Las horas van en UTC (`…Z`): el calendario
 * del miembro las muestra en SU zona, que es lo correcto para una cita.
 */

export interface EventoReserva {
  /** Identificador estable: si el miembro lo agrega dos veces, el calendario lo actualiza en vez de duplicarlo. */
  reservaId: string;
  folio: string | null;
  set: string;
  inicio: Date | string;
  fin: Date | string;
  estudio: string;
  direccion?: string | null;
  /** E.164 sin '+', como se guarda en config.contacto.whatsapp_e164. */
  whatsapp?: string | null;
  email?: string | null;
  /** URL del QR de la reserva en la app. */
  urlReserva?: string | null;
  invitados?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 20260920T170000Z */
export function fechaICS(x: Date | string): string {
  const d = new Date(x);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Escapa texto para una propiedad iCalendar (RFC 5545 §3.3.11). */
export function escaparICS(texto: string): string {
  return texto
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/** Pliega líneas de más de 75 octetos (RFC 5545 §3.1): continuación = CRLF + espacio. */
export function plegarLineaICS(linea: string): string {
  const enc = new TextEncoder();
  if (enc.encode(linea).length <= 75) return linea;
  const partes: string[] = [];
  let actual = '';
  for (const ch of linea) {
    // 74 en las continuaciones: el espacio inicial cuenta.
    const limite = partes.length === 0 ? 75 : 74;
    if (enc.encode(actual + ch).length > limite) {
      partes.push(actual);
      actual = ch;
    } else {
      actual += ch;
    }
  }
  partes.push(actual);
  return partes.join('\r\n ');
}

function minutosEntre(a: Date | string, b: Date | string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

export function tituloEvento(e: EventoReserva): string {
  return `${e.estudio} · ${e.set}`;
}

/** Texto del evento: lo que el miembro necesita saber al ver la cita. */
export function descripcionEvento(e: EventoReserva): string {
  const min = minutosEntre(e.inicio, e.fin);
  const duracion = min % 60 === 0 ? `${min / 60} h` : `${min} min`;
  const lineas = [
    `Sesión en ${e.set} (${duracion}).`,
    e.folio ? `Folio: ${e.folio}` : null,
    e.invitados && e.invitados > 0 ? `Invitados: ${e.invitados}` : null,
    '',
    'Al llegar, muestra tu código QR en recepción.',
    e.urlReserva ? `Tu QR: ${e.urlReserva}` : null,
    '',
    e.whatsapp ? `WhatsApp ${e.estudio}: https://wa.me/${e.whatsapp.replace(/\D/g, '')}` : null,
    e.email ? `Correo: ${e.email}` : null
  ];
  // Sin líneas vacías dobles ni al final.
  return lineas
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Archivo .ics completo (CRLF, líneas plegadas, aviso 1 h antes). */
export function generarICS(e: EventoReserva, ahora: Date = new Date()): string {
  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EKKO Studio//Reservas//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:reserva-${e.reservaId}@ekkostudio.app`,
    `DTSTAMP:${fechaICS(ahora)}`,
    `DTSTART:${fechaICS(e.inicio)}`,
    `DTEND:${fechaICS(e.fin)}`,
    `SUMMARY:${escaparICS(tituloEvento(e))}`,
    `DESCRIPTION:${escaparICS(descripcionEvento(e))}`,
    e.direccion ? `LOCATION:${escaparICS(e.direccion)}` : null,
    e.urlReserva ? `URL:${e.urlReserva}` : null,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escaparICS(`Tu sesión en ${e.set} empieza en 1 hora`)}`,
    'TRIGGER:-PT1H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return lineas
    .filter((l): l is string => l !== null)
    .map(plegarLineaICS)
    .join('\r\n') + '\r\n';
}

/** Enlace que abre Google Calendar con el evento prellenado. */
export function urlGoogleCalendar(e: EventoReserva): string {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: tituloEvento(e),
    dates: `${fechaICS(e.inicio)}/${fechaICS(e.fin)}`,
    details: descripcionEvento(e)
  });
  if (e.direccion) p.set('location', e.direccion);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

export function nombreArchivoICS(e: EventoReserva): string {
  return `ekko-${(e.folio ?? e.reservaId).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ics`;
}

/**
 * Descarga/abre el .ics. Con `data:` y no con un Blob URL: en la PWA instalada de
 * iOS los `blob:` no abren el diálogo de Calendario, y un `data:text/calendar` sí.
 */
export function descargarICS(e: EventoReserva): void {
  const href = `data:text/calendar;charset=utf-8,${encodeURIComponent(generarICS(e))}`;
  const a = document.createElement('a');
  a.href = href;
  a.download = nombreArchivoICS(e);
  document.body.appendChild(a);
  a.click();
  a.remove();
}
