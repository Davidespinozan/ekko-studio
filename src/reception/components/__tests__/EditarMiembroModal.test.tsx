import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';
import { EditarMiembroModal, type MiembroEditable } from '../EditarMiembroModal';

/**
 * R5 (paridad SALA): "Editar datos" en recepción es SOLO contacto. Poner
 * status='activo' o un plan a mano (sin cobrar) ya no es posible desde aquí:
 * esas acciones viven en MembresiaCard / EstadoCuentaCard con su regla y su
 * rastro. Este test fija que el modal no ofrezca ni envíe esos campos.
 */

const mockActualizar = vi.fn();
vi.mock('../../lib/accionesMiembro', () => ({
  actualizarMiembro: (...args: unknown[]) => mockActualizar(...args)
}));

const MIEMBRO: MiembroEditable = {
  id: 'm-1',
  nombre: 'Ana',
  email: 'ana@cravia.mx',
  telefono: '123'
};

function renderModal() {
  return render(
    <ToastProvider>
      <EditarMiembroModal miembro={MIEMBRO} onClose={vi.fn()} onGuardado={vi.fn()} />
    </ToastProvider>
  );
}

describe('EditarMiembroModal · solo contacto (R5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActualizar.mockResolvedValue({ success: true, cambios: ['nombre'] });
  });

  it('no ofrece estado de cuenta ni plan', () => {
    renderModal();
    expect(screen.queryByLabelText('Estado')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Plan')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/motivo del cambio/i)).not.toBeInTheDocument();
  });

  it('envía únicamente nombre, teléfono y email (nunca status ni membresia_tier)', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Nombre'), { target: { value: 'Ana María' } });
    fireEvent.click(screen.getByRole('button', { name: /guardar/i }));
    await waitFor(() => expect(mockActualizar).toHaveBeenCalledTimes(1));
    const [id, patch] = mockActualizar.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('m-1');
    expect(patch).toEqual({ nombre: 'Ana María', telefono: '123', email: 'ana@cravia.mx' });
    expect(patch).not.toHaveProperty('status');
    expect(patch).not.toHaveProperty('membresia_tier');
    expect(patch).not.toHaveProperty('motivo');
  });

  it('avisa que cambiar el email cambia el acceso', () => {
    renderModal();
    expect(screen.queryByText(/inicia sesión/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email (acceso)'), { target: { value: 'nueva@cravia.mx' } });
    expect(screen.getByText(/también cambia el correo con el que el cliente inicia sesión/i)).toBeInTheDocument();
  });
});
