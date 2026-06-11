import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * Bloque D: CorregirCheckinModal exige motivo antes de llamar al backend.
 */

const { mockCorregir } = vi.hoisted(() => ({ mockCorregir: vi.fn() }));
vi.mock('../../lib/accionesReserva', () => ({
  corregirCheckin: (...args: unknown[]) => mockCorregir(...args),
  MOTIVOS_CORREGIR_CHECKIN: ['Check-in al miembro equivocado', 'Error operativo de recepción']
}));

import { CorregirCheckinModal } from '../CorregirCheckinModal';

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
      <CorregirCheckinModal reserva={RESERVA} onClose={vi.fn()} onDone={vi.fn()} />
    </ToastProvider>
  );
}

describe('CorregirCheckinModal · motivo obligatorio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCorregir.mockResolvedValue({ success: true, status: 'confirmada' });
  });

  it('sin motivo no llama al backend', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /corregir check-in/i }));
    await waitFor(() => expect(mockCorregir).not.toHaveBeenCalled());
  });

  it('con motivo llama al backend con (reserva_id, motivo)', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText(/motivo de la corrección/i), {
      target: { value: 'Check-in al miembro equivocado' }
    });
    fireEvent.click(screen.getByRole('button', { name: /corregir check-in/i }));
    await waitFor(() => expect(mockCorregir).toHaveBeenCalledTimes(1));
    expect(mockCorregir).toHaveBeenCalledWith('r1', 'Check-in al miembro equivocado');
  });
});
