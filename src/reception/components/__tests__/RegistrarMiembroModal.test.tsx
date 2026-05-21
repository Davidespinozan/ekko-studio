import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Verifica el cableado de RegistrarMiembroModal (Sprint RP-4): que llame
 * a `reception-create-member` con los campos correctos y SIN `rol` ni
 * `tenant_id` (la función los fija), las validaciones del form, el
 * manejo de email duplicado y — defensa en profundidad — que la UI no
 * exponga ningún campo de rol.
 *
 * Mocks ESTABLES vía `vi.hoisted` (lección del bucle infinito de RP-3a):
 * devuelven siempre la misma referencia, como los hooks reales.
 */

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetchMock: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: { auth: { getSession: () => h.getSession() } }
}));
vi.mock('@shared/hooks/useToast', () => ({ useToast: () => h.toast }));

import { RegistrarMiembroModal } from '../RegistrarMiembroModal';

beforeEach(() => {
  h.getSession.mockReset();
  h.fetchMock.mockReset();
  h.toast.success.mockReset();
  h.toast.error.mockReset();
  vi.stubGlobal('fetch', h.fetchMock);
  h.getSession.mockResolvedValue({ data: { session: { access_token: 'tok-1' } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RegistrarMiembroModal · wiring', () => {
  it('registrar → llama reception-create-member con campos correctos, SIN rol ni tenant_id', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        user: { email: 'nuevo@correo.com', nombre: 'Nuevo Cliente', rol: 'miembro', password: 'x' }
      })
    });
    const onRegistrado = vi.fn();

    render(<RegistrarMiembroModal onClose={vi.fn()} onRegistrado={onRegistrado} />);

    fireEvent.change(screen.getByLabelText('Nombre completo'), {
      target: { value: 'Nuevo Cliente' }
    });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'Nuevo@Correo.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar miembro' }));

    await waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));

    const [url, opts] = h.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/.netlify/functions/reception-create-member');
    const body = JSON.parse(opts.body as string);
    expect(body.nombre).toBe('Nuevo Cliente');
    expect(body.email).toBe('nuevo@correo.com'); // normalizado a lowercase
    expect(body.password.length).toBeGreaterThanOrEqual(8);
    // Seguridad: el front nunca manda rol ni tenant_id — la función los fija.
    expect(body).not.toHaveProperty('rol');
    expect(body).not.toHaveProperty('tenant_id');
    expect(body).not.toHaveProperty('membresia_tier');

    // Fase de credenciales + aviso explícito de pendiente de activación (D2).
    expect(await screen.findByText(/MIEMBRO REGISTRADO/i)).toBeInTheDocument();
    expect(screen.getByText(/PENDIENTE DE ACTIVACIÓN/i)).toBeInTheDocument();
  });

  it('submit deshabilitado hasta que nombre, email y password sean válidos', () => {
    render(<RegistrarMiembroModal onClose={vi.fn()} onRegistrado={vi.fn()} />);
    const submit = screen.getByRole('button', { name: 'Registrar miembro' });

    expect(submit).toBeDisabled(); // nombre y email vacíos

    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'A' } }); // < 2
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'correo-malo' } });
    expect(submit).toBeDisabled(); // nombre corto + email inválido

    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Ana López' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@correo.com' } });
    expect(submit).not.toBeDisabled(); // password autogenerada ya es válida

    fireEvent.change(screen.getByLabelText('Contraseña temporal'), { target: { value: 'corta' } });
    expect(submit).toBeDisabled(); // password < 8
  });

  it('email duplicado → toast traducido, no avanza a la vista de credenciales', async () => {
    h.fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Ya existe una cuenta con ese email' })
    });
    const onRegistrado = vi.fn();

    render(<RegistrarMiembroModal onClose={vi.fn()} onRegistrado={onRegistrado} />);
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Ana López' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@correo.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar miembro' }));

    await waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith('Ya existe una cuenta con ese email.')
    );
    expect(onRegistrado).not.toHaveBeenCalled();
    expect(screen.queryByText(/MIEMBRO REGISTRADO/i)).not.toBeInTheDocument();
  });

  it('seguridad: el modal no expone ningún campo de rol', () => {
    render(<RegistrarMiembroModal onClose={vi.fn()} onRegistrado={vi.fn()} />);
    // El modal de admin (CrearAccesoModal) usa radios para elegir rol.
    // Acá no debe existir ninguno: recepción nunca crea staff.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/rol/i)).not.toBeInTheDocument();
  });
});
