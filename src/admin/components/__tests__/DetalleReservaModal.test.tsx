import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * Bloque B/C: DetalleReservaModal en modo read-only (recepción, sin onCancelar)
 * NO debe mostrar el botón "Cancelar reserva", aunque la reserva sea
 * confirmada y futura. Con onCancelar (admin) sí lo muestra.
 */

const { single, toastMock } = vi.hoisted(() => ({
  single: vi.fn(),
  // Identidad ESTABLE: el modal depende de `toast` en un useEffect; un objeto
  // nuevo por render dispararía un re-fetch en loop (se quedaría en skeleton).
  toastMock: { error: () => {}, success: () => {}, info: () => {} }
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ single }) }) })
  }
}));
vi.mock('@shared/hooks/useToast', () => ({ useToast: () => toastMock }));

import DetalleReservaModal from '../DetalleReservaModal';

const ROW = {
  id: 'r1',
  slot_inicio: '2999-01-01T10:00:00.000Z',
  slot_fin: '2999-01-01T11:00:00.000Z',
  status: 'confirmada',
  folio: 'EKK-000999',
  created_at: '2026-01-01T10:00:00.000Z',
  cancelada_at: null,
  cancelada_motivo: null,
  cancelada_por: null,
  recurso: { nombre: 'Estudio A' },
  usuario: { nombre: 'Ana', email: 'ana@cravia.mx', membresia_tier: 'pro' }
};

describe('DetalleReservaModal · read-only para recepción', () => {
  beforeEach(() => {
    single.mockResolvedValue({ data: ROW, error: null });
  });

  it('SIN onCancelar (recepción): no muestra "Cancelar reserva"', async () => {
    render(<DetalleReservaModal reservaId="r1" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Folio EKK-000999/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /cancelar reserva/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cerrar/i })).toBeInTheDocument();
  });

  it('CON onCancelar (admin): muestra "Cancelar reserva" para confirmada futura', async () => {
    render(<DetalleReservaModal reservaId="r1" onClose={vi.fn()} onCancelar={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Folio EKK-000999/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /cancelar reserva/i })).toBeInTheDocument();
  });
});
