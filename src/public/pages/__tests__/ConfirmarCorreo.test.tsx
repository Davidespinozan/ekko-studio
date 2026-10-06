import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { leerEnlaceConfirmacion } from '@public/lib/confirmacionCorreo';

/**
 * PKG-06C (FR-24) · /confirmar-correo: el proveedor verifica el token una sola vez
 * (también en StrictMode), el token sale de la barra al leerlo, después el dueño
 * del buzón elige su contraseña. Un enlace inválido, vencido o reusado da un texto
 * escrito a mano (nunca el error del proveedor). Si abandona sin contraseña, se
 * cierra la sesión del enlace.
 */

const h = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn()
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: { auth: { verifyOtp: h.verifyOtp, updateUser: h.updateUser, signOut: h.signOut } }
}));

import ConfirmarCorreo from '../ConfirmarCorreo';

const TOKEN = 'b'.repeat(56);
let ruta = '';

function Ruta() {
  const l = useLocation();
  ruta = l.pathname + l.search;
  return null;
}

function abrir(url: string, estricto = false) {
  const arbol = (
    <MemoryRouter initialEntries={[url]}>
      <Ruta />
      <Routes>
        <Route path="/confirmar-correo" element={<ConfirmarCorreo />} />
        <Route path="/app" element={<p>app del miembro</p>} />
      </Routes>
    </MemoryRouter>
  );
  return render(estricto ? <StrictMode>{arbol}</StrictMode> : arbol);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.verifyOtp.mockResolvedValue({ data: { session: { access_token: 'x' }, user: { id: 'u' } }, error: null });
  h.updateUser.mockResolvedValue({ data: {}, error: null });
  h.signOut.mockResolvedValue({ error: null });
});

describe('leerEnlaceConfirmacion', () => {
  it('acepta solo token con forma válida y tipos de confirmación (no recovery ni email_change)', () => {
    expect(leerEnlaceConfirmacion(`?token_hash=${TOKEN}&type=magiclink`)).toEqual({ tokenHash: TOKEN, tipo: 'magiclink' });
    expect(leerEnlaceConfirmacion(`?token_hash=${TOKEN}&type=signup`)).toMatchObject({ tipo: 'signup' });
    expect(leerEnlaceConfirmacion(`?token_hash=${TOKEN}&type=recovery`)).toBeNull();
    expect(leerEnlaceConfirmacion(`?token_hash=${TOKEN}&type=email_change`)).toBeNull();
    expect(leerEnlaceConfirmacion('?token_hash=corto&type=magiclink')).toBeNull();
    expect(leerEnlaceConfirmacion(`?token_hash=${TOKEN}<script>&type=magiclink`)).toBeNull();
    expect(leerEnlaceConfirmacion('')).toBeNull();
  });
});

describe('ConfirmarCorreo', () => {
  it('14 · verifica UNA vez aun en StrictMode, quita el token de la URL y pide la contraseña', async () => {
    abrir(`/confirmar-correo?token_hash=${TOKEN}&type=magiclink`, true);
    expect(await screen.findByText('Elige tu contraseña')).toBeTruthy();
    expect(h.verifyOtp).toHaveBeenCalledTimes(1);
    expect(h.verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN, type: 'magiclink' });
    expect(ruta).toBe('/confirmar-correo');
  });

  it('con contraseña creada, la cuenta está lista y sigue a la app; no cierra sesión', async () => {
    const { unmount } = abrir(`/confirmar-correo?token_hash=${TOKEN}&type=magiclink`);
    await screen.findByText('Elige tu contraseña');
    fireEvent.change(screen.getByLabelText('Nueva contraseña'), { target: { value: 'Clave1234' } });
    fireEvent.change(screen.getByLabelText('Repite la contraseña'), { target: { value: 'Clave1234' } });
    fireEvent.click(screen.getByRole('button', { name: /Crear mi contraseña/ }));
    expect(await screen.findByText('Tu cuenta está lista')).toBeTruthy();
    expect(h.updateUser).toHaveBeenCalledWith({ password: 'Clave1234' });
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(await screen.findByText('app del miembro')).toBeTruthy();
    unmount();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('15 · enlace vencido o reusado: texto escrito a mano, nunca el error del proveedor', async () => {
    h.verifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { message: 'Email link is invalid or has expired (otp_expired)' } });
    abrir(`/confirmar-correo?token_hash=${TOKEN}&type=magiclink`);
    expect(await screen.findByText('El enlace expiró o ya se usó')).toBeTruthy();
    expect(screen.queryByText(/otp_expired|invalid/)).toBeNull();
    expect(ruta).toBe('/confirmar-correo');
  });

  it('enlace mal formado o de otro tipo: ni siquiera se consulta al proveedor', async () => {
    abrir(`/confirmar-correo?token_hash=${TOKEN}&type=recovery`);
    expect(await screen.findByText('El enlace expiró o ya se usó')).toBeTruthy();
    expect(h.verifyOtp).not.toHaveBeenCalled();
  });

  it('el proveedor no responde (excepción) → inválido, sin texto crudo', async () => {
    h.verifyOtp.mockRejectedValue(new Error('NetworkError at fetch https://x.supabase.co/auth/v1/verify'));
    abrir(`/confirmar-correo?token_hash=${TOKEN}&type=magiclink`);
    expect(await screen.findByText('El enlace expiró o ya se usó')).toBeTruthy();
    expect(screen.queryByText(/NetworkError|supabase/)).toBeNull();
  });

  it('verificó pero abandona sin contraseña → se cierra la sesión del enlace', async () => {
    const { unmount } = abrir(`/confirmar-correo?token_hash=${TOKEN}&type=magiclink`);
    await screen.findByText('Elige tu contraseña');
    unmount();
    await waitFor(() => expect(h.signOut).toHaveBeenCalledTimes(1));
  });
});
