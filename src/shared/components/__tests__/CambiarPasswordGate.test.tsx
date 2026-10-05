import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * CambiarPasswordGate: aparece SOLO cuando el usuario tiene una notificación
 * `cambiar_password` sin leer (la deja el alta/reset de staff). "Ahora no" lo
 * oculta en esta sesión. PKG-02C: al cambiar la clave NO escribe en la
 * notificación (el servidor la cierra con el cambio real de contraseña); solo
 * vuelve a consultar y se oculta únicamente si el servidor ya la cerró.
 */

const mockMaybeSingle = vi.fn();
const mockUpdate = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
const mockUpdateUser = vi.fn();

vi.mock('@shared/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = () => mockMaybeSingle();
  return {
    supabase: {
      from: () => ({ ...chain, update: mockUpdate }),
      auth: { updateUser: (...args: unknown[]) => mockUpdateUser(...args) }
    }
  };
});

vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({ usuario: { id: 'u-1', rol: 'miembro' } })
}));

import { CambiarPasswordGate } from '../CambiarPasswordGate';

describe('CambiarPasswordGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sin aviso pendiente no renderiza nada', async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
    const { container } = render(<CambiarPasswordGate />);
    await waitFor(() => expect(mockMaybeSingle).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('con aviso cambiar_password muestra el modal bloqueante', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'n-1' }, error: null });
    render(<CambiarPasswordGate />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Cambia tu contraseña ahora/)).toBeInTheDocument();
  });

  it('"Ahora no" lo oculta (vuelve en la siguiente entrada)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'n-1' }, error: null });
    render(<CambiarPasswordGate />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByText(/Ahora no/));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('al guardar una clave válida actualiza Auth, NO escribe la notificación y se oculta cuando el servidor ya la cerró', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: { id: 'n-1' }, error: null }) // consulta inicial: aviso abierto
      .mockResolvedValue({ data: null, error: null }); // tras el cambio: el servidor lo cerró
    mockUpdateUser.mockResolvedValue({ error: null });
    render(<CambiarPasswordGate />);
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Nueva contraseña'), { target: { value: 'Segura123' } });
    fireEvent.change(screen.getByLabelText('Repite la contraseña'), { target: { value: 'Segura123' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar mi contraseña/ }));
    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'Segura123' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockMaybeSingle).toHaveBeenCalledTimes(2);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('si el servidor NO cerró el aviso tras el cambio, el gate sigue en pantalla (sin falso "cambiada")', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'n-1' }, error: null });
    mockUpdateUser.mockResolvedValue({ error: null });
    render(<CambiarPasswordGate />);
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Nueva contraseña'), { target: { value: 'Segura123' } });
    fireEvent.change(screen.getByLabelText('Repite la contraseña'), { target: { value: 'Segura123' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar mi contraseña/ }));
    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalled());
    await waitFor(() => expect(mockMaybeSingle).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('una clave débil no llama a Auth y muestra el error', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: 'n-1' }, error: null });
    render(<CambiarPasswordGate />);
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText('Nueva contraseña'), { target: { value: 'sololetras' } });
    fireEvent.change(screen.getByLabelText('Repite la contraseña'), { target: { value: 'sololetras' } });
    fireEvent.click(screen.getByRole('button', { name: /Guardar mi contraseña/ }));
    expect(await screen.findByText('Usa al menos una letra y un número.')).toBeInTheDocument();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
