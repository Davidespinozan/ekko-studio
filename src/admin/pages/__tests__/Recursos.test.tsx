import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@shared/providers/ToastProvider';

/**
 * PKG-02A (C02 · F13/F14) — /admin/estudios:
 *  - error al cargar la lista → ErrorCarga, nunca "No hay estudios activos.";
 *  - en el modal, error al cargar los planes → aviso y Guardar deshabilitado
 *    (no se guarda "abierto a todos" por una lista vacía falsa).
 */

const h = vi.hoisted(() => ({
  recursos: { recursos: [] as Record<string, unknown>[], isLoading: false, error: false, refetch: vi.fn() },
  tiers: { data: [] as unknown, error: null as unknown }
}));
vi.mock('../../hooks/useAdminData', () => ({
  useRecursosAdmin: () => h.recursos,
  updateRecurso: vi.fn(),
  insertRecurso: vi.fn()
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.order = () => Promise.resolve(h.tiers);
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', slug: 'ekko', config: {} }) }));
vi.mock('../../components/ImageUploader', () => ({ default: () => null }));
vi.mock('@shared/components/EstudiosServicioModal', () => ({ EstudiosServicioModal: () => null }));

import Recursos from '../Recursos';

const montar = () => render(<ToastProvider><Recursos /></ToastProvider>);

describe('Recursos (PKG-02A)', () => {
  beforeEach(() => {
    h.recursos = { recursos: [], isLoading: false, error: false, refetch: vi.fn() };
    h.tiers = { data: [{ slug: 'pro', nombre: 'Pro' }], error: null };
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success vacío → "No hay estudios activos." (vacío real)', () => {
    montar();
    expect(screen.getByText('No hay estudios activos.')).toBeInTheDocument();
  });

  it('error de lista → "No pudimos cargar los estudios." + Reintentar; NO el vacío', () => {
    h.recursos.error = true;
    montar();
    expect(screen.queryByText('No hay estudios activos.')).not.toBeInTheDocument();
    expect(screen.getByText('No pudimos cargar los estudios.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.recursos.refetch).toHaveBeenCalledTimes(1);
  });

  it('modal: planes OK → se puede guardar', async () => {
    montar();
    fireEvent.click(screen.getAllByRole('button', { name: /Nuevo estudio/ })[0]);
    expect(await screen.findByText('Planes con acceso a este estudio')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar' })).not.toBeDisabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('modal: planes en ERROR → aviso, sin selector, y Guardar deshabilitado (no se guarda con [] falso)', async () => {
    h.tiers = { data: null, error: { message: 'permission denied' } };
    montar();
    fireEvent.click(screen.getAllByRole('button', { name: /Nuevo estudio/ })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent(/No pudimos cargar los planes/);
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/permission denied/);
  });
});
