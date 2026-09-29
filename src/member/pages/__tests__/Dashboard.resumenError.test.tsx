import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * PKG-02A (C02 · F06) — Inicio del miembro: si el resumen (membresía/créditos/
 * sesiones) no se pudo leer, NO se pinta un carnet "sin plan" con 0 créditos y
 * 0 sesiones; se muestra el error con Reintentar.
 */

const h = vi.hoisted(() => ({
  resumen: {
    resumen: { proximasCount: 0, sesionesEsteMes: 0, membresia: null as unknown, tier: null as unknown },
    isLoading: false,
    error: false,
    refetch: vi.fn()
  }
}));

vi.mock('@shared/lib/supabase', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit']) builder[m] = () => builder;
  builder.then = (cb: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(cb);
  return { supabase: { from: () => builder } };
});
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: { id: 'u-1', nombre: 'Ana', bloqueado_hasta: null, membresia_tier: 'starter', status: 'activo' } }) }));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', nombre: 'EKKO' }) }));
vi.mock('@member/hooks/useResumenMiembro', () => ({ useResumenMiembro: () => h.resumen }));

import Dashboard from '../Dashboard';

const montar = () => render(<MemoryRouter><Dashboard /></MemoryRouter>);

describe('Dashboard miembro · resumen (PKG-02A)', () => {
  beforeEach(() => {
    h.resumen.isLoading = false;
    h.resumen.error = false;
    h.resumen.refetch = vi.fn();
    h.resumen.resumen = { proximasCount: 0, sesionesEsteMes: 0, membresia: null, tier: null };
  });

  it('success sin membresía → carnet real (sección "Membresía" visible)', async () => {
    montar();
    expect(await screen.findByText('Membresía')).toBeInTheDocument();
    expect(screen.queryByText('No pudimos cargar tu membresía.')).not.toBeInTheDocument();
  });

  it('error → "No pudimos cargar tu membresía." + Reintentar; NO carnet con ceros', async () => {
    h.resumen.error = true;
    montar();
    expect(await screen.findByText('No pudimos cargar tu membresía.')).toBeInTheDocument();
    expect(screen.queryByText('Membresía')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(h.resumen.refetch).toHaveBeenCalledTimes(1);
  });

  it('cargando → skeleton, sin carnet ni error', async () => {
    h.resumen.isLoading = true;
    montar();
    await waitFor(() => expect(screen.queryByText('Membresía')).not.toBeInTheDocument());
    expect(screen.queryByText('No pudimos cargar tu membresía.')).not.toBeInTheDocument();
  });
});
