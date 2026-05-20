import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockRpc = vi.fn();
vi.mock('@shared/lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) }
}));

const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock('@shared/hooks/useToast', () => ({ useToast: () => toast }));

import { CancelarReservaRecepcionModal } from '../CancelarReservaRecepcionModal';

const RESERVA = {
  id: 'r-1',
  slot_inicio: '2026-07-01T18:00:00Z',
  recurso_nombre: 'Estudio A'
};

describe('CancelarReservaRecepcionModal', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it('confirmar → llama cancelar_reserva_atomic con el reserva_id correcto', async () => {
    mockRpc.mockResolvedValue({ data: {}, error: null });
    const onCancelada = vi.fn();
    const onClose = vi.fn();

    render(
      <CancelarReservaRecepcionModal
        reserva={RESERVA}
        miembroNombre="Ana López"
        onClose={onClose}
        onCancelada={onCancelada}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /cancelar reserva/i }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    expect(mockRpc).toHaveBeenCalledWith('cancelar_reserva_atomic', {
      p_reserva_id: 'r-1',
      p_motivo: undefined
    });
    await waitFor(() => {
      expect(onCancelada).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('error del RPC → toast con mensaje traducido, no cierra', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'EKKO_RESERVA_PASADA: ya pasó' }
    });
    const onCancelada = vi.fn();
    const onClose = vi.fn();

    render(
      <CancelarReservaRecepcionModal
        reserva={RESERVA}
        miembroNombre="Ana López"
        onClose={onClose}
        onCancelada={onCancelada}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /cancelar reserva/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toMatch(/ya pasó/i);
    expect(onCancelada).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
