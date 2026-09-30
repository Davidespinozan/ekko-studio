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
  planesResultado: { data: [{ slug: 'pro', nombre: 'Pro', precio_centavos: 120000 }], error: null } as { data: unknown; error: unknown },
  activarMock: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    auth: { getSession: () => h.getSession() },
    // usePlanesActivos: from('tiers').select().eq().order() → planes activos.
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () =>
            Promise.resolve(h.planesResultado)
        })
      })
    })
  }
}));
vi.mock('@shared/hooks/useToast', () => ({ useToast: () => h.toast }));
vi.mock('@shared/lib/checkout', async (orig) => ({
  ...(await orig<typeof import('@shared/lib/checkout')>()),
  activarMembresiaMostrador: (...args: unknown[]) => h.activarMock(...args)
}));

import { RegistrarMiembroModal } from '../RegistrarMiembroModal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
  h.getSession.mockReset();
  h.fetchMock.mockReset();
  h.activarMock.mockReset();
  h.activarMock.mockResolvedValue({ success: true });
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

  it('con plan → manda membresia_tier, activa en el mismo paso y muestra "activa"', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        user: { id: 'u-nuevo', email: 'ana@correo.com', nombre: 'Ana López', rol: 'miembro', password: 'x' }
      })
    });

    render(<RegistrarMiembroModal onClose={vi.fn()} onRegistrado={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Ana López' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@correo.com' } });
    // El plan se carga async desde la BD: esperar la opción antes de elegirla.
    await screen.findByRole('option', { name: 'Pro' });
    fireEvent.change(screen.getByLabelText(/Plan inicial/i), { target: { value: 'pro' } });
    // PKG-01D: con plan, el método es obligatorio y no se manda ningún importe.
    expect(screen.getByRole('button', { name: 'Registrar y activar' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'Efectivo' }));
    expect(screen.getByTestId('resumen-cobro')).toHaveTextContent('$1,200 cobrado');
    fireEvent.click(screen.getByRole('button', { name: 'Registrar y activar' }));

    await waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((h.fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.membresia_tier).toBe('pro');

    await waitFor(() => expect(h.activarMock).toHaveBeenCalledWith('u-nuevo', 'pro', { operationId: expect.stringMatching(UUID), metodo: 'efectivo' }));
    expect(h.activarMock.mock.calls[0][2]).not.toHaveProperty('monto');
    expect(await screen.findByText(/Membresía/i)).toBeInTheDocument();
    expect(screen.getByText(/activa/i)).toBeInTheDocument();
    expect(screen.queryByText(/PENDIENTE DE ACTIVACIÓN/i)).not.toBeInTheDocument();
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
    // Aquí no debe existir ninguno: recepción nunca crea staff.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/rol/i)).not.toBeInTheDocument();
  });
});

// ── PKG-02A (C02 · F12) ───────────────────────────────────────────────────────
describe('RegistrarMiembroModal · planes (PKG-02A)', () => {
  afterEach(() => {
    h.planesResultado = { data: [{ slug: 'pro', nombre: 'Pro', precio_centavos: 120000 }], error: null };
  });

  it('planes en ERROR → selector deshabilitado "planes no disponibles" + aviso; nunca se interpreta como "sin planes"', async () => {
    h.planesResultado = { data: null, error: { message: 'permission denied' } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<RegistrarMiembroModal onClose={vi.fn()} onRegistrado={vi.fn()} />);
    const select = (await screen.findByLabelText(/Plan inicial/)) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(true));
    expect(screen.getByRole('option', { name: '— planes no disponibles —' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Pro' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/No pudimos cargar los planes/);
    expect(document.body.textContent).not.toMatch(/permission denied/);
  });
});

// ── PKG-01D · venta de mostrador en el alta ──────────────────────────────────
describe('RegistrarMiembroModal · venta de mostrador (PKG-01D)', () => {
  const nuevo = () => ({ ok: true, json: async () => ({ success: true, user: { id: 'u-nuevo', email: 'ana@correo.com', nombre: 'Ana', rol: 'miembro', password: 'x' } }) });
  async function registrarConPlan(metodo: string) {
    render(<RegistrarMiembroModal onClose={vi.fn()} onRegistrado={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Nombre completo'), { target: { value: 'Ana López' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ana@correo.com' } });
    await screen.findByRole('option', { name: 'Pro' });
    fireEvent.change(screen.getByLabelText(/Plan inicial/i), { target: { value: 'pro' } });
    fireEvent.click(screen.getByRole('radio', { name: metodo }));
    fireEvent.click(screen.getByRole('button', { name: 'Registrar y activar' }));
  }

  it('cortesía se muestra como $0 cobrado sin perder el precio de lista', async () => {
    h.fetchMock.mockResolvedValue(nuevo());
    render(<RegistrarMiembroModal onClose={vi.fn()} onRegistrado={vi.fn()} />);
    await screen.findByRole('option', { name: 'Pro' });
    fireEvent.change(screen.getByLabelText(/Plan inicial/i), { target: { value: 'pro' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Cortesía' }));
    expect(screen.getByTestId('resumen-cobro')).toHaveTextContent('$0 cobrado');
    expect(screen.getByTestId('resumen-cobro')).toHaveTextContent('Precio de lista $1,200');
  });

  it('si la activación falla, "Reintentar activación" usa el MISMO operation_id (no duplica la venta)', async () => {
    h.fetchMock.mockResolvedValue(nuevo());
    h.activarMock.mockRejectedValueOnce(new Error('HTTP 502')).mockResolvedValueOnce({ success: true, idempotente: true });
    await registrarConPlan('Transferencia');
    expect(await screen.findByText(/PENDIENTE DE ACTIVACIÓN/i)).toBeInTheDocument();
    const primera = h.activarMock.mock.calls[0][2] as { operationId: string };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar activación' }));
    await waitFor(() => expect(h.activarMock).toHaveBeenCalledTimes(2));
    expect(h.activarMock.mock.calls[1]).toEqual(['u-nuevo', 'pro', { operationId: primera.operationId, metodo: 'transferencia' }]);
    expect(await screen.findByText(/ya puede reservar/i)).toBeInTheDocument();
  });

  it('el éxito no se presenta hasta que el servidor confirma (success:false → pendiente)', async () => {
    h.fetchMock.mockResolvedValue(nuevo());
    h.activarMock.mockResolvedValueOnce({ success: false });
    await registrarConPlan('Efectivo');
    expect(await screen.findByText(/PENDIENTE DE ACTIVACIÓN/i)).toBeInTheDocument();
    expect(screen.queryByText(/ya puede reservar/i)).not.toBeInTheDocument();
  });
});
