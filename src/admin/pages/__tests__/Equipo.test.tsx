import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/** PKG-02A (caso mitigado) — /admin/equipo: error → estado de error, no "Sin personas con acceso todavía." + toast. */

const h = vi.hoisted(() => ({ resultado: { data: [] as unknown, error: null as unknown }, llamadas: 0 }));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'neq']) c[m] = () => c;
      c.order = () => c;
      c.then = (cb: (v: unknown) => unknown) => { h.llamadas++; return Promise.resolve(h.resultado).then(cb); };
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: { id: 'admin-1', rol: 'admin' } }) }));
vi.mock('@shared/lib/backend', () => ({ backendPost: vi.fn() }));
vi.mock('@reception/components/ResetPasswordModal', () => ({ ResetPasswordModal: () => null }));
vi.mock('../../components/CrearAccesoModal', () => ({ default: () => null }));
vi.mock('../../components/CredencialesCreadasModal', () => ({ default: () => null }));
vi.mock('../../components/CambiarRolModal', () => ({ default: () => null }));

import Equipo from '../Equipo';

const montar = () => render(<ToastProvider><Equipo /></ToastProvider>);

describe('Equipo (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: [], error: null };
    h.llamadas = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success vacío → "Sin personas con acceso todavía." (vacío real)', async () => {
    montar();
    expect(await screen.findByText('Sin personas con acceso todavía.')).toBeInTheDocument();
  });

  it('error → "No pudimos cargar el equipo." + Reintentar; NO el vacío', async () => {
    h.resultado = { data: null, error: { message: 'permission denied' } };
    montar();
    expect(await screen.findByText('No pudimos cargar el equipo.')).toBeInTheDocument();
    expect(screen.queryByText('Sin personas con acceso todavía.')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied/);
    const antes = h.llamadas;
    h.resultado = { data: [], error: null };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(h.llamadas).toBeGreaterThan(antes));
    expect(await screen.findByText('Sin personas con acceso todavía.')).toBeInTheDocument();
  });
});
