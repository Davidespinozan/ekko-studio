import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * PKG-02A — lista de reservas del admin:
 *  - (caso mitigado) error de la consulta → ErrorCarga, no "No hay reservas que coincidan…" + toast;
 *  - (F23) error del catálogo de estudios → el filtro dice "Estudios no disponibles".
 */

const h = vi.hoisted(() => ({
  porTabla: {} as Record<string, { data: unknown; error: unknown }>,
  llamadas: {} as Record<string, number>
}));
vi.mock('@shared/lib/supabase', () => ({
  supabase: {
    from: (tabla: string) => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'lt', 'order', 'limit']) c[m] = () => c;
      c.then = (cb: (v: unknown) => unknown) => {
        h.llamadas[tabla] = (h.llamadas[tabla] ?? 0) + 1;
        return Promise.resolve(h.porTabla[tabla] ?? { data: [], error: null }).then(cb);
      };
      return c;
    }
  }
}));
vi.mock('@shared/hooks/useTenant', () => ({ useTenant: () => ({ id: 't-1', config: {} }) }));

import ReservasVistaLista from '../ReservasVistaLista';

const montar = () => render(<ReservasVistaLista refreshTick={0} onVerDetalle={vi.fn()} />);

describe('ReservasVistaLista (PKG-02A)', () => {
  beforeEach(() => {
    h.porTabla = {};
    h.llamadas = {};
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('success vacío → "No hay reservas que coincidan con los filtros." (vacío real)', async () => {
    montar();
    expect(await screen.findByText('No hay reservas que coincidan con los filtros.')).toBeInTheDocument();
  });

  it('error de reservas → "No pudimos cargar las reservas." + Reintentar; NO el vacío', async () => {
    h.porTabla.reservas = { data: null, error: { message: 'permission denied' } };
    montar();
    expect(await screen.findByText('No pudimos cargar las reservas.')).toBeInTheDocument();
    expect(screen.queryByText('No hay reservas que coincidan con los filtros.')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/permission denied/);
    h.porTabla.reservas = { data: [], error: null };
    const antes = h.llamadas.reservas;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(h.llamadas.reservas).toBeGreaterThan(antes));
    expect(await screen.findByText('No hay reservas que coincidan con los filtros.')).toBeInTheDocument();
  });

  it('F23 · error del catálogo de estudios → el filtro muestra "Estudios no disponibles" en vez de un selector sin opciones', async () => {
    h.porTabla.recursos = { data: null, error: { message: 'timeout' } };
    montar();
    expect(await screen.findByRole('option', { name: /Estudios no disponibles/ })).toBeInTheDocument();
  });
});
