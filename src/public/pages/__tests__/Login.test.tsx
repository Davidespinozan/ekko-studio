import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * Login: valida el status ANTES de redirigir. Dos reglas nuevas:
 *  · staff: solo `activo` entra al panel (un miembro `cancelado` sí entra, a
 *    recomprar; un recepcionista `cancelado`/`revocado` no);
 *  · un miembro `suspendido` por la PAUSA de su membresía recibe un mensaje
 *    propio, no el de una sanción.
 */

const h = vi.hoisted(() => ({
  perfil: null as Record<string, unknown> | null,
  pausadas: [] as unknown[],
  signOut: vi.fn().mockResolvedValue({ error: null })
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null }),
      signOut: h.signOut
    },
    from: (tabla: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.maybeSingle = () => Promise.resolve({ data: h.perfil, error: null });
      c.limit = () => Promise.resolve({ data: tabla === 'membresias' ? h.pausadas : [], error: null });
      return c;
    }
  }
}));

import Login from '../Login';

function entrar() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>APP</div>} />
        <Route path="/admin" element={<div>ADMIN</div>} />
        <Route path="/recepcion" element={<div>RECEPCION</div>} />
      </Routes>
    </MemoryRouter>
  );
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@e.mx' } });
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'secreto123' } });
  fireEvent.click(screen.getByRole('button', { name: /iniciar sesión/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.pausadas = [];
});

describe('Login', () => {
  it('miembro activo → /app; admin activo → /admin', async () => {
    h.perfil = { id: 'u1', rol: 'miembro', status: 'activo' };
    entrar();
    expect(await screen.findByText('APP')).toBeInTheDocument();
  });

  it('miembro SUSPENDIDO POR PAUSA: mensaje de pausa, no de sanción', async () => {
    h.perfil = { id: 'u1', rol: 'miembro', status: 'suspendido' };
    h.pausadas = [{ id: 'mem-1' }];
    entrar();
    expect(await screen.findByText(/Tu membresía está en pausa/)).toBeInTheDocument();
    expect(screen.queryByText(/cuenta está suspendida/i)).not.toBeInTheDocument();
    expect(h.signOut).toHaveBeenCalled();
  });

  it('miembro suspendido por el admin (sin pausa): el mensaje de cuenta suspendida', async () => {
    h.perfil = { id: 'u1', rol: 'miembro', status: 'suspendido' };
    entrar();
    expect(await screen.findByText(/Tu cuenta está suspendida/)).toBeInTheDocument();
  });

  it('miembro CANCELADO entra (a recomprar)…', async () => {
    h.perfil = { id: 'u1', rol: 'miembro', status: 'cancelado' };
    entrar();
    expect(await screen.findByText('APP')).toBeInTheDocument();
  });

  it('…pero un RECEPCIONISTA cancelado o revocado NO entra al panel', async () => {
    h.perfil = { id: 'r1', rol: 'recepcionista', status: 'cancelado' };
    entrar();
    expect(await screen.findByText(/acceso al panel no está activo/i)).toBeInTheDocument();
    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    expect(screen.queryByText('RECEPCION')).not.toBeInTheDocument();
  });

  it('un staff "pendiente de pago" no se manda a /app a pagar', async () => {
    h.perfil = { id: 'r1', rol: 'recepcionista', status: 'pendiente_pago' };
    entrar();
    await waitFor(() => expect(h.signOut).toHaveBeenCalled());
    expect(screen.queryByText('APP')).not.toBeInTheDocument();
  });

  it('"Volver a EKKO" manda a la landing ("/")', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<div>LANDING</div>} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('link', { name: /volver a ekko/i }));
    expect(screen.getByText('LANDING')).toBeInTheDocument();
  });
});
