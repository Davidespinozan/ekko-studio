import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

/**
 * PKG-06D (E-16) · Un fallo al hidratar la cuenta NUNCA se queda en "cargando":
 * `isLoading` dura hasta que la hidratación termina y un error deja
 * `errorSesion` (reintentable) o `sin_perfil` (sesión válida sin perfil).
 * La autorización sigue siendo del servidor: aquí solo se prueba el estado.
 */

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn().mockResolvedValue({ error: null }),
  maybeSingle: vi.fn(),
  select: vi.fn(),
  listeners: [] as Array<(event: string, session: unknown) => void>
}));

vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: () => h.getSession(),
      signOut: () => h.signOut(),
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        h.listeners.push(cb);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }
    },
    from: () => ({
      select: (cols: string) => {
        h.select(cols);
        return { eq: () => ({ maybeSingle: () => h.maybeSingle() }) };
      }
    })
  }
}));
vi.mock('@shared/lib/sentry', () => ({ setSentryUser: vi.fn() }));

import { AuthProvider, useAuth } from '../AuthProvider';
import { ErrorSesion } from '@shared/components/ErrorSesion';

const SESION = { user: { id: 'auth-1' }, access_token: 't', expires_at: 9e9 };
const PERFIL = { id: 'u-1', auth_id: 'auth-1', email: 'ana@test.mx', rol: 'miembro', status: 'activo', nombre: 'Ana' };

function Sonda() {
  const { isLoading, usuario, authUser, errorSesion, reintentarSesion, signOut } = useAuth();
  if (isLoading) return <div data-testid="cargando">cargando</div>;
  if (errorSesion) return <ErrorSesion tipo={errorSesion} onReintentar={() => void reintentarSesion()} onCerrarSesion={() => void signOut()} />;
  if (!authUser) return <div data-testid="sin-sesion">sin sesión</div>;
  return <div data-testid="listo">{usuario?.nombre ?? 'sin perfil'}</div>;
}

const montar = () => render(<AuthProvider><Sonda /></AuthProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  h.listeners.length = 0;
  h.getSession.mockResolvedValue({ data: { session: SESION } });
  h.maybeSingle.mockResolvedValue({ data: PERFIL, error: null });
});

describe('AuthProvider · hidratación honesta (E-16)', () => {
  it('37 · éxito: sale de "cargando" con el perfil; pide SOLO las columnas del cliente (nunca *)', async () => {
    montar();
    expect(screen.getByTestId('cargando')).toBeInTheDocument();
    expect(await screen.findByTestId('listo')).toHaveTextContent('Ana');
    const cols = String(h.select.mock.calls[0][0]);
    expect(cols).not.toBe('*');
    expect(cols).toMatch(/\bid, auth_id, tenant_id, email, nombre\b/);
    expect(cols).not.toMatch(/notas_admin|sancion_motivo/);
  });

  it('38 · sin sesión: termina de cargar sin consultar el perfil', async () => {
    h.getSession.mockResolvedValue({ data: { session: null } });
    montar();
    expect(await screen.findByTestId('sin-sesion')).toBeInTheDocument();
    expect(h.select).not.toHaveBeenCalled();
  });

  it('39/40 · la consulta del perfil falla → estado de error (no "cargando"); Reintentar vuelve a hidratar', async () => {
    h.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'FetchError: network' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    montar();
    const err = await screen.findByTestId('error-sesion');
    expect(err).toHaveTextContent('No pudimos cargar tu cuenta.');
    expect(err.textContent).not.toMatch(/FetchError|network/);
    expect(screen.queryByTestId('cargando')).toBeNull();
    fireEvent.click(screen.getByText('Reintentar'));
    expect(await screen.findByTestId('listo')).toHaveTextContent('Ana');
    expect(h.maybeSingle).toHaveBeenCalledTimes(2);
  });

  it('39b · excepción de red al restaurar la sesión → error, no carga infinita', async () => {
    h.getSession.mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    montar();
    expect(await screen.findByTestId('error-sesion')).toBeInTheDocument();
  });

  it('41 · sesión válida sin perfil en el estudio → "sin_perfil" con salida (cerrar sesión), sin Reintentar', async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    montar();
    const err = await screen.findByTestId('error-sesion');
    expect(err).toHaveTextContent('ya no tiene un perfil');
    expect(screen.queryByText('Reintentar')).toBeNull();
    fireEvent.click(screen.getByText('Cerrar sesión'));
    await waitFor(() => expect(h.signOut).toHaveBeenCalledTimes(1));
  });

  it('42 · al cerrar sesión (evento de Auth) el error se limpia; el servidor sigue decidiendo la autorización', async () => {
    h.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    montar();
    await screen.findByTestId('error-sesion');
    await act(async () => { h.listeners.forEach((cb) => cb('SIGNED_OUT', null)); });
    expect(await screen.findByTestId('sin-sesion')).toBeInTheDocument();
  });
});
