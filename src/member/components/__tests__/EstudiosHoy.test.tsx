import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** Inicio del miembro (modelo SALA): carrusel de estudios con foto; un fallo se dice, no se oculta como vacío. */
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

import { EstudiosHoy, detalleEstudio } from '../EstudiosHoy';

const montar = () => render(<MemoryRouter><EstudiosHoy /></MemoryRouter>);

beforeEach(() => { h.resultado = { data: [], error: null }; h.llamadas = 0; vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('EstudiosHoy', () => {
  it('cada estudio con su detalle y enlace; "Ver todos" lleva a Estudios', async () => {
    h.resultado = { data: [{ id: 'r1', slug: 'black', nombre: 'Set Black', foto_url: 'https://x/a.jpg', capacidad_personas: 4, tipo_contenido: ['Podcast'] }], error: null };
    montar();
    const tarjeta = await screen.findByRole('link', { name: /Set Black/ });
    expect(tarjeta).toHaveAttribute('href', '/app/estudios/black');
    expect(tarjeta).toHaveTextContent('Podcast · Hasta 4 personas');
    expect(screen.getByRole('link', { name: /Ver todos/ })).toHaveAttribute('href', '/app/estudios');
  });

  it('sin estudios no pinta nada; con error lo dice y reintenta', async () => {
    const { container } = montar();
    await waitFor(() => expect(h.llamadas).toBe(1));
    expect(container).toBeEmptyDOMElement();
    h.resultado = { data: null, error: { message: 'permission denied' } };
    const otro = montar();
    expect(await otro.findByText('No pudimos cargar los estudios.')).toBeInTheDocument();
    h.resultado = { data: [], error: null };
    fireEvent.click(otro.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(h.llamadas).toBe(3));
  });

  it('detalleEstudio arma tipo y capacidad', () => {
    expect(detalleEstudio({ capacidad_personas: 1, tipo_contenido: [] })).toBe('Hasta 1 persona');
    expect(detalleEstudio({ capacidad_personas: null, tipo_contenido: ['Reels'] })).toBe('Reels');
    expect(detalleEstudio({ capacidad_personas: null, tipo_contenido: null })).toBe('');
  });
});
