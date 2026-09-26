import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * A8 (paridad SALA): al miembro cuya membresía se PAUSÓ mientras tenía la app
 * abierta se le decía "Tu cuenta está suspendida" (mensaje de sanción). Ahora
 * MemberLayout distingue pausa de suspensión antes de cerrar la sesión y manda
 * a /login con el mensaje de pausa, igual que ya hacía Login.
 */

const h = vi.hoisted(() => ({
  usuario: null as Record<string, unknown> | null,
  authUser: { id: 'auth-1' } as Record<string, unknown> | null,
  signOut: vi.fn(),
  enPausa: false
}));

vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({ authUser: h.authUser, usuario: h.usuario, isLoading: false, signOut: h.signOut })
}));
vi.mock('@shared/lib/pausaMembresia', async (orig) => {
  const real = await orig<typeof import('@shared/lib/pausaMembresia')>();
  return { ...real, suspendidoPorPausa: vi.fn(async () => h.enPausa) };
});

import MemberLayout from '../MemberLayout';
import { MENSAJE_EN_PAUSA } from '@shared/lib/pausaMembresia';

function LoginStub() {
  const { state } = useLocation() as { state?: { mensaje?: string } };
  return <div data-testid="login">{state?.mensaje ?? 'sin mensaje'}</div>;
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="/app/*" element={<MemberLayout />} />
        <Route path="/login" element={<LoginStub />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.authUser = { id: 'auth-1' };
  h.signOut.mockResolvedValue(undefined);
});

describe('MemberLayout · sesión abierta cuya cuenta deja de estar activa', () => {
  it('suspendido por una PAUSA: cierra sesión y manda a /login con el mensaje de pausa', async () => {
    h.usuario = { id: 'u1', rol: 'miembro', status: 'suspendido', email: 'a@b.c' };
    h.enPausa = true;
    renderApp();
    await waitFor(() => expect(screen.getByTestId('login')).toHaveTextContent(MENSAJE_EN_PAUSA));
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });

  it('suspendido por el estudio (sin pausa): mensaje genérico de suspensión', async () => {
    h.usuario = { id: 'u1', rol: 'miembro', status: 'suspendido', email: 'a@b.c' };
    h.enPausa = false;
    renderApp();
    await waitFor(() => expect(screen.getByTestId('login')).toHaveTextContent(/suspendida/i));
    expect(screen.getByTestId('login')).not.toHaveTextContent(/en pausa/i);
    expect(h.signOut).toHaveBeenCalledTimes(1);
  });

  it('el mensaje sobrevive aunque signOut ya haya dejado authUser en null', async () => {
    h.usuario = { id: 'u1', rol: 'miembro', status: 'suspendido', email: 'a@b.c' };
    h.enPausa = true;
    h.signOut.mockImplementation(async () => {
      h.authUser = null;
    });
    renderApp();
    await waitFor(() => expect(screen.getByTestId('login')).toHaveTextContent(MENSAJE_EN_PAUSA));
  });
});
