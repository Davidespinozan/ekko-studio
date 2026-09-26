import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * "Revocar acceso" solo cambia `usuarios.status`. Login valida al ENTRAR, pero un
 * admin revocado con la sesión ya abierta seguía dentro del panel: el guard solo
 * miraba el rol.
 */

const auth = vi.hoisted(() => ({
  usuario: { rol: 'admin', status: 'activo' } as { rol: string; status: string },
  signOut: vi.fn()
}));

vi.mock('@shared/hooks/useAuth', () => ({
  useAuth: () => ({
    authUser: { id: 'auth-1' },
    usuario: auth.usuario,
    isLoading: false,
    signOut: auth.signOut
  })
}));

import { useAdminGuard } from '../useAdminGuard';

function Panel() {
  const { isLoading } = useAdminGuard();
  return <div>{isLoading ? 'CARGANDO' : 'PANEL_ADMIN'}</div>;
}
function LoginStub() {
  const { state } = useLocation();
  return <div>LOGIN · {(state as { mensaje?: string } | null)?.mensaje}</div>;
}

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/admin" element={<Panel />} />
        <Route path="/login" element={<LoginStub />} />
        <Route path="/app" element={<div>APP_MIEMBRO</div>} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  auth.usuario = { rol: 'admin', status: 'activo' };
  auth.signOut.mockClear();
});

describe('useAdminGuard', () => {
  it('admin activo: entra al panel y no se le cierra la sesión', () => {
    renderPanel();
    expect(screen.getByText('PANEL_ADMIN')).toBeInTheDocument();
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it('admin REVOCADO con la sesión abierta: nunca ve el panel, va al login con el motivo y se cierra la sesión', async () => {
    auth.usuario = { rol: 'admin', status: 'revocado' };
    renderPanel();
    expect(screen.queryByText('PANEL_ADMIN')).not.toBeInTheDocument();
    expect(await screen.findByText(/LOGIN · Tu acceso fue revocado/)).toBeInTheDocument();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('no-admin: a /app, sin cerrar su sesión', async () => {
    auth.usuario = { rol: 'miembro', status: 'activo' };
    renderPanel();
    expect(await screen.findByText('APP_MIEMBRO')).toBeInTheDocument();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});
