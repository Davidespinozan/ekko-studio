import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** PKG-02A (C02 · F15) — /app/reservas: error ≠ "Sin sesiones agendadas". */

const h = vi.hoisted(() => ({
  resultado: { data: [] as unknown, error: null as unknown },
  llamadas: 0,
  usuario: { id: 'u-1', nombre: 'Ana' }
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit']) c[m] = () => c;
      c.then = (cb: (v: unknown) => unknown) => { h.llamadas++; return Promise.resolve(h.resultado).then(cb); };
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useAuth', () => ({ useAuth: () => ({ usuario: h.usuario }) }));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));

import MisReservas from '../MisReservas';

const montar = () => render(<MemoryRouter><MisReservas /></MemoryRouter>);

describe('MisReservas (PKG-02A)', () => {
  beforeEach(() => {
    h.resultado = { data: [], error: null };
    h.llamadas = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success vacío → "Sin sesiones agendadas" (vacío real)', async () => {
    montar();
    expect(await screen.findByText('Sin sesiones agendadas')).toBeInTheDocument();
  });

  it('error → "No pudimos cargar tus reservas." + Reintentar; nunca "Sin sesiones agendadas"', async () => {
    h.resultado = { data: null, error: { message: 'permission denied' } };
    montar();
    expect(await screen.findByText('No pudimos cargar tus reservas.')).toBeInTheDocument();
    expect(screen.queryByText('Sin sesiones agendadas')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied/);
    const antes = h.llamadas;
    h.resultado = { data: [], error: null };
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(h.llamadas).toBeGreaterThan(antes));
    expect(await screen.findByText('Sin sesiones agendadas')).toBeInTheDocument();
  });
});
