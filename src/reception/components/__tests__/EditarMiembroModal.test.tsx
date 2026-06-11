import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';
import { EditarMiembroModal, type MiembroEditable } from '../EditarMiembroModal';

/**
 * Bloque A: el modal exige "Motivo del cambio" cuando se cambia status o tier,
 * y NO lo pide cuando solo se editan datos de contacto.
 */

const mockActualizar = vi.fn();
vi.mock('../../lib/accionesMiembro', () => ({
  actualizarMiembro: (...args: unknown[]) => mockActualizar(...args)
}));

const MIEMBRO: MiembroEditable = {
  id: 'm-1',
  nombre: 'Ana',
  email: 'ana@cravia.mx',
  telefono: '123',
  status: 'activo',
  membresia_tier: 'basica'
};

function renderModal() {
  return render(
    <ToastProvider>
      <EditarMiembroModal miembro={MIEMBRO} onClose={vi.fn()} onGuardado={vi.fn()} />
    </ToastProvider>
  );
}

describe('EditarMiembroModal · motivo obligatorio (Bloque A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActualizar.mockResolvedValue({ success: true, cambios: ['status→suspendido'] });
  });

  it('no muestra el campo motivo si no cambió nada sensible', () => {
    renderModal();
    expect(screen.queryByLabelText(/motivo del cambio/i)).not.toBeInTheDocument();
  });

  it('al cambiar status aparece el campo motivo', () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Estado'), { target: { value: 'suspendido' } });
    expect(screen.getByLabelText(/motivo del cambio/i)).toBeInTheDocument();
  });

  it('cambiar status sin elegir motivo NO llama al backend', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Estado'), { target: { value: 'suspendido' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar/i }));
    await waitFor(() => {
      expect(mockActualizar).not.toHaveBeenCalled();
    });
  });

  it('cambiar status con motivo SÍ llama al backend con el motivo', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Estado'), { target: { value: 'suspendido' } });
    fireEvent.change(screen.getByLabelText(/motivo del cambio/i), {
      target: { value: 'Cliente solicitó suspensión' }
    });
    fireEvent.click(screen.getByRole('button', { name: /guardar/i }));
    await waitFor(() => {
      expect(mockActualizar).toHaveBeenCalledTimes(1);
    });
    const [, patch] = mockActualizar.mock.calls[0] as [string, Record<string, unknown>];
    expect(patch.status).toBe('suspendido');
    expect(patch.motivo).toBe('Cliente solicitó suspensión');
  });

  it('editar solo contacto NO requiere motivo', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Ana María' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar/i }));
    await waitFor(() => {
      expect(mockActualizar).toHaveBeenCalledTimes(1);
    });
    const [, patch] = mockActualizar.mock.calls[0] as [string, Record<string, unknown>];
    expect(patch.nombre).toBe('Ana María');
    expect(patch.motivo).toBeUndefined();
  });
});
