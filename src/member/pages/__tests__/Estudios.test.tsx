import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** PKG-02A (caso mitigado) — /app/estudios: error → estado de error, no cuadrícula vacía + toast. */

const h = vi.hoisted(() => ({ resultado: { data: [] as unknown, error: null as unknown }, llamadas: 0 }));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) c[m] = () => c;
      c.order = () => { h.llamadas++; return Promise.resolve(h.resultado); };
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));

import Estudios from '../Estudios';

const montar = () => render(<MemoryRouter><Estudios /></MemoryRouter>);

describe('Estudios (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: [], error: null };
    h.llamadas = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success con estudios → tarjetas', async () => {
    h.resultado = { data: [{ id: 'r1', slug: 'black', nombre: 'Set Black', descripcion: null, foto_url: null, activo: true, tiers_permitidos: [], costo_creditos: 1 }], error: null };
    montar();
    expect(await screen.findByText('Set Black')).toBeInTheDocument();
  });

  it('error → "No pudimos cargar los estudios." + Reintentar (sin cuadrícula vacía silenciosa)', async () => {
    h.resultado = { data: null, error: { message: 'permission denied' } };
    montar();
    expect(await screen.findByText('No pudimos cargar los estudios.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied/);
    h.resultado = { data: [{ id: 'r1', slug: 'black', nombre: 'Set Black', descripcion: null, foto_url: null, activo: true, tiers_permitidos: [], costo_creditos: 1 }], error: null };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(h.llamadas).toBe(2));
    expect(await screen.findByText('Set Black')).toBeInTheDocument();
  });
});
