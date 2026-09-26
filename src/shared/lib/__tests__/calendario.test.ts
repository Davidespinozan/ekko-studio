import { describe, it, expect } from 'vitest';
import {
  generarICS,
  urlGoogleCalendar,
  descripcionEvento,
  fechaICS,
  escaparICS,
  plegarLineaICS,
  nombreArchivoICS,
  type EventoReserva
} from '../calendario';

// 17:00–18:00 en Mazatlán (UTC-7) = 00:00–01:00 UTC del día siguiente.
const evento: EventoReserva = {
  reservaId: '11111111-2222-3333-4444-555555555555',
  folio: 'EKK-000123',
  set: 'Set Podcast',
  inicio: '2026-09-21T00:00:00.000Z',
  fin: '2026-09-21T01:00:00.000Z',
  estudio: 'EKKO Studio',
  direccion: 'Av. del Mar 123, Mazatlán, Sinaloa',
  whatsapp: '526691234567',
  email: 'hola@ekkostudio.app',
  urlReserva: 'https://ekkostudio.app/app/qr/11111111-2222-3333-4444-555555555555',
  invitados: 2
};
const AHORA = new Date('2026-09-20T12:00:00.000Z');

const lineas = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');

describe('calendario — lo que pidió el cliente en la invitación', () => {
  it('fecha y hora, set, duración, ubicación, información de la reserva y contacto', () => {
    const l = lineas(generarICS(evento, AHORA));
    expect(l).toContain('DTSTART:20260921T000000Z');
    expect(l).toContain('DTEND:20260921T010000Z');
    expect(l).toContain('SUMMARY:EKKO Studio · Set Podcast');
    expect(l).toContain('LOCATION:Av. del Mar 123\\, Mazatlán\\, Sinaloa');
    const desc = l.find((x) => x.startsWith('DESCRIPTION:Sesión'))!;
    expect(desc).toContain('Set Podcast (1 h)');
    expect(desc).toContain('Folio: EKK-000123');
    expect(desc).toContain('Invitados: 2');
    expect(desc).toContain('https://wa.me/526691234567');
    expect(desc).toContain('hola@ekkostudio.app');
  });

  it('duración que no son horas exactas se dice en minutos', () => {
    expect(descripcionEvento({ ...evento, fin: '2026-09-21T01:30:00.000Z' })).toContain('(90 min)');
  });

  it('sin dirección ni contacto configurados: no deja líneas vacías ni "null"', () => {
    const ics = generarICS({ ...evento, direccion: null, whatsapp: null, email: null, urlReserva: null, invitados: 0 }, AHORA);
    expect(ics).not.toMatch(/LOCATION|null|undefined|wa\.me/);
  });
});

describe('generarICS — formato válido (RFC 5545)', () => {
  const ics = generarICS(evento, AHORA);

  it('estructura, CRLF y final de línea', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const par of ['VCALENDAR', 'VEVENT', 'VALARM']) {
      expect(ics).toContain(`BEGIN:${par}`);
      expect(ics).toContain(`END:${par}`);
    }
  });

  it('UID estable por reserva: agregarla dos veces no la duplica', () => {
    expect(lineas(ics)).toContain('UID:reserva-11111111-2222-3333-4444-555555555555@ekkostudio.app');
    expect(generarICS(evento, new Date('2026-09-22T00:00:00Z'))).toContain('UID:reserva-11111111');
  });

  it('avisa 1 hora antes', () => {
    expect(lineas(ics)).toContain('TRIGGER:-PT1H');
  });

  it('ninguna línea pasa de 75 octetos (las largas se pliegan con CRLF + espacio)', () => {
    const enc = new TextEncoder();
    for (const linea of ics.split('\r\n')) expect(enc.encode(linea).length).toBeLessThanOrEqual(75);
  });

  it('plegar y desplegar conserva el texto, también con acentos y emoji', () => {
    const largo = 'DESCRIPTION:' + 'Sesión de grabación — café ☕ y más ñandúes. '.repeat(6);
    expect(plegarLineaICS(largo).replace(/\r\n /g, '')).toBe(largo);
  });

  it('escapa comas, punto y coma, barras y saltos de línea', () => {
    expect(escaparICS('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('fechaICS siempre en UTC', () => {
    expect(fechaICS('2026-09-20T17:00:00-07:00')).toBe('20260921T000000Z');
  });
});

describe('urlGoogleCalendar', () => {
  it('abre la plantilla con título, fechas en UTC, detalles y ubicación', () => {
    const u = new URL(urlGoogleCalendar(evento));
    expect(u.origin + u.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(u.searchParams.get('action')).toBe('TEMPLATE');
    expect(u.searchParams.get('text')).toBe('EKKO Studio · Set Podcast');
    expect(u.searchParams.get('dates')).toBe('20260921T000000Z/20260921T010000Z');
    expect(u.searchParams.get('location')).toBe('Av. del Mar 123, Mazatlán, Sinaloa');
    expect(u.searchParams.get('details')).toContain('Folio: EKK-000123');
  });

  it('sin dirección no manda location', () => {
    expect(new URL(urlGoogleCalendar({ ...evento, direccion: null })).searchParams.has('location')).toBe(false);
  });
});

describe('nombreArchivoICS', () => {
  it('usa el folio, en minúsculas y sin caracteres raros', () => {
    expect(nombreArchivoICS(evento)).toBe('ekko-ekk-000123.ics');
  });
});
