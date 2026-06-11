import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * Bloque E: EnviarAvisoModal exige un mensaje antes de llamar al backend.
 */

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));
vi.mock('@shared/lib/backend', () => ({
  backendPost: (...args: unknown[]) => mockPost(...args)
}));

import { EnviarAvisoModal } from '../EnviarAvisoModal';

function renderModal() {
  return render(
    <ToastProvider>
      <EnviarAvisoModal miembroId="m1" miembroNombre="Ana López" onClose={vi.fn()} />
    </ToastProvider>
  );
}

describe('EnviarAvisoModal · mensaje obligatorio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ success: true });
  });

  it('sin mensaje no llama al backend', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await waitFor(() => expect(mockPost).not.toHaveBeenCalled());
  });

  it('con mensaje llama a reception-notificar-miembro', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Mensaje'), { target: { value: 'Tu pago vence mañana' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar/i }));
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith('reception-notificar-miembro', {
      miembro_id: 'm1',
      mensaje: 'Tu pago vence mañana'
    });
  });
});
