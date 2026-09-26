import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't1', nombre: 'EKKO Studio', config: {} }) }));
vi.mock('@shared/hooks/useLandingConfig', () => ({
  useLandingConfig: () => ({
    footer: { direccion: 'Av. del Mar 123, Mazatlán', email: 'hola@ekkostudio.app' },
    contacto: { whatsapp_e164: '526691234567' }
  })
}));

const descargar = vi.fn();
vi.mock('@shared/lib/calendario', async (orig) => ({
  ...(await orig<typeof import('@shared/lib/calendario')>()),
  descargarICS: (...a: unknown[]) => descargar(...a)
}));

import { AgregarAlCalendario } from '../AgregarAlCalendario';

const reserva = {
  id: 'res-1',
  folio: 'EKK-000123',
  slot_inicio: '2026-09-21T00:00:00.000Z',
  slot_fin: '2026-09-21T01:00:00.000Z',
  invitados_count: 1,
  recurso_nombre: 'Set Podcast'
};

beforeEach(() => vi.clearAllMocks());

describe('AgregarAlCalendario', () => {
  it('ofrece Apple Calendar y Google Calendar', () => {
    render(<AgregarAlCalendario reserva={reserva} />);
    expect(screen.getByRole('button', { name: 'Apple Calendar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Google Calendar' })).toBeInTheDocument();
  });

  it('Google: enlace a la plantilla con el set, las fechas y la dirección del estudio', () => {
    render(<AgregarAlCalendario reserva={reserva} />);
    const u = new URL((screen.getByRole('link', { name: 'Google Calendar' }) as HTMLAnchorElement).href);
    expect(u.searchParams.get('text')).toBe('EKKO Studio · Set Podcast');
    expect(u.searchParams.get('dates')).toBe('20260921T000000Z/20260921T010000Z');
    expect(u.searchParams.get('location')).toBe('Av. del Mar 123, Mazatlán');
    expect(u.searchParams.get('details')).toContain('https://wa.me/526691234567');
  });

  it('Apple: descarga el .ics con la reserva, la ubicación, el contacto y el enlace al QR', () => {
    render(<AgregarAlCalendario reserva={reserva} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apple Calendar' }));
    expect(descargar).toHaveBeenCalledWith(
      expect.objectContaining({
        reservaId: 'res-1',
        folio: 'EKK-000123',
        set: 'Set Podcast',
        direccion: 'Av. del Mar 123, Mazatlán',
        whatsapp: '526691234567',
        email: 'hola@ekkostudio.app',
        invitados: 1,
        urlReserva: expect.stringContaining('/app/qr/res-1')
      })
    );
  });
});
