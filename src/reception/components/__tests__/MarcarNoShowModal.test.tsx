import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * Bloque D: MarcarNoShowModal exige motivo antes de llamar al backend.
 */

const { mockMarcar } = vi.hoisted(() => ({ mockMarcar: vi.fn() }));
vi.mock('../../lib/accionesReserva', () => ({
  marcarNoShow: (...args: unknown[]) => mockMarcar(...args),
  MOTIVOS_NO_SHOW: ['Cliente no se presentó', 'Doble-reserva del cliente (ya estaba en otra)']
}));

import { MarcarNoShowModal } from '../MarcarNoShowModal';

const RESERVA = {
  id: 'r1',
  folio: 'EKK-000001',
  slot_inicio: '2020-01-01T10:00:00.000Z',
  recurso_nombre: 'Estudio A',
  miembro_nombre: 'Ana López'
};

function renderModal() {
  return render(
    <ToastProvider>
      <MarcarNoShowModal reserva={RESERVA} onClose={vi.fn()} onDone={vi.fn()} />
    </ToastProvider>
  );
}

describe('MarcarNoShowModal · motivo obligatorio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarcar.mockResolvedValue({ success: true, status: 'no_show', no_shows_count: 1, bloqueado_hasta: null });
  });

  it('sin motivo no llama al backend', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /marcar no-show/i }));
    await waitFor(() => expect(mockMarcar).not.toHaveBeenCalled());
  });

  it('con motivo llama al backend con (reserva_id, motivo)', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText(/motivo del no-show/i), {
      target: { value: 'Cliente no se presentó' }
    });
    fireEvent.click(screen.getByRole('button', { name: /marcar no-show/i }));
    await waitFor(() => expect(mockMarcar).toHaveBeenCalledTimes(1));
    expect(mockMarcar).toHaveBeenCalledWith('r1', 'Cliente no se presentó');
  });
});
