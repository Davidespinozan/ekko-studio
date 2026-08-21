import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/** MarcarAsistioModal exige motivo antes de llamar al backend. */

const { mockAsistio } = vi.hoisted(() => ({ mockAsistio: vi.fn() }));
vi.mock('../../lib/accionesReserva', () => ({
  marcarAsistio: (...args: unknown[]) => mockAsistio(...args),
  MOTIVOS_ASISTIO: ['Sí vino, no le hicieron check-in', 'Cancelación por error']
}));

import { MarcarAsistioModal } from '../MarcarAsistioModal';

const RESERVA = {
  id: 'r1',
  folio: 'EKK-000001',
  slot_inicio: '2020-01-01T10:00:00.000Z',
  recurso_nombre: 'Estudio A',
  miembro_nombre: 'Ana López',
  status: 'no_show'
};

function renderModal() {
  return render(
    <ToastProvider>
      <MarcarAsistioModal reserva={RESERVA} onClose={vi.fn()} onDone={vi.fn()} />
    </ToastProvider>
  );
}

describe('MarcarAsistioModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAsistio.mockResolvedValue({ success: true, status: 'completada' });
  });

  it('sin motivo no llama al backend', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /marcar que sí asistió/i }));
    await waitFor(() => expect(mockAsistio).not.toHaveBeenCalled());
  });

  it('con motivo llama al backend con (reserva_id, motivo) y explica que revierte la falta', async () => {
    renderModal();
    expect(screen.getByText(/La falta se revierte/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/motivo de la corrección/i), {
      target: { value: 'Sí vino, no le hicieron check-in' }
    });
    fireEvent.click(screen.getByRole('button', { name: /marcar que sí asistió/i }));
    await waitFor(() => expect(mockAsistio).toHaveBeenCalledTimes(1));
    expect(mockAsistio).toHaveBeenCalledWith('r1', 'Sí vino, no le hicieron check-in');
  });
});
